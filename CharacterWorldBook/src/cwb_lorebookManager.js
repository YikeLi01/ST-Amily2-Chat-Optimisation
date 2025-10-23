import { state } from './cwb_state.js';
import { logError, logDebug, showToastr, parseCustomFormat } from './cwb_utils.js';

const { SillyTavern, TavernHelper } = window;

export async function getTargetWorldBook() {
    logDebug('[CWB-DIAGNOSTIC] getTargetWorldBook called. Current state:', { 
        target: state.worldbookTarget, 
        book: state.customWorldBook 
    });
    if (state.worldbookTarget === 'custom' && state.customWorldBook) {
        return state.customWorldBook;
    }
    try {
        let localTavernHelper = TavernHelper;
        if (!localTavernHelper) {
            // TavernHelper 未定义的情况下触发，但是为什么？
            (localTavernHelper = window.TavernHelper);
        }
        const primaryBook = await localTavernHelper.getCurrentCharPrimaryLorebook();
        if (!primaryBook) {
            showToastr('error', '当前角色未设置主世界书。');
            return null;
        }
        return primaryBook;
    } catch (error) {
        logError('获取主世界书时出错:', error);
        return null;
    }
}

export async function deleteLorebookEntries(uids) {
    if (!Array.isArray(uids) || uids.length === 0) return;

    try {
        const context = SillyTavern.getContext();
        if (!context || !context.characterId) {
            throw new Error('没有选择角色，无法删除。');
        }
        const book = await getTargetWorldBook();
        if (!book) throw new Error('未找到目标世界书。');

        await TavernHelper.deleteLorebookEntries(book, uids.map(Number));
    } catch (error) {
        logError('删除世界书条目失败:', error);
        showToastr('error', `删除失败: ${error.message}`);
    }
}

export async function saveDescriptionToLorebook(characterName, newDescription, startFloor, endFloor) {
    if (!characterName?.trim()) return false;

    try {
        const context = SillyTavern.getContext();
        if (!context || !context.characterId) {
            showToastr('error', '没有选择角色，无法保存到世界书。');
            return false;
        }
        let chatIdentifier = state.currentChatFileIdentifier || '未知聊天';
        chatIdentifier = chatIdentifier.replace(/ imported/g, '');
        
        const safeCharName = characterName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5·""“”_-]/g, ',');
        const floorRange = `${startFloor + 1}-${endFloor + 1}`;

        const newComment = `${safeCharName}-${chatIdentifier}`;

        let bookName;
        if (state.worldbookTarget === 'custom' && state.customWorldBook) {
            bookName = state.customWorldBook;
        } else {
            bookName = await TavernHelper.getCurrentCharPrimaryLorebook();
        }

        if (!bookName) {
            showToastr('error', '未能确定要写入的世界书。请检查主世界书或自定义世界书设置。');
            return false;
        }

        const entries = (await TavernHelper.getLorebookEntries(bookName)) || [];
        let existing = entries.find(e => 
            Array.isArray(e.keys) &&
            e.keys.includes(chatIdentifier) &&
            e.keys.includes(safeCharName) &&
            !e.keys.includes('Amily2角色总集')
        );

        const entryData = {
            comment: newComment,
            content: newDescription,
            keys: [chatIdentifier, safeCharName, floorRange],
            enabled: true,
            type: 'selective',
        };

        if (existing) {
            await TavernHelper.setLorebookEntries(bookName, [{ uid: existing.uid, ...entryData }]);
        } else {
            const cwbEntries = entries.filter(e => 
                Array.isArray(e.keys) && 
                e.keys.includes(chatIdentifier) && 
                !e.keys.includes('Amily2角色总集')
            );
            let maxDepth = 7000;
            cwbEntries.forEach(entry => {
                if (entry.position === 'at_depth_as_system' && typeof entry.depth === 'number') {
                    if (entry.depth >= 7001 && entry.depth > maxDepth) {
                        maxDepth = entry.depth;
                    }
                }
            });
            
            const newDepth = maxDepth + 1;
            let maxOrder = 7000;
            if (cwbEntries.length > 0) {
                maxOrder = cwbEntries.reduce((max, entry) => {
                    const order = Number(entry.order);
                    return !isNaN(order) && order > max ? order : max;
                }, 7000);
            }
            
            const newEntryData = {
                ...entryData,
                order: 100, 
                position: 'at_depth_as_system',
                depth: newDepth,
            };
            
            logDebug(`创建新角色条目：${safeCharName}`, {
                position: newEntryData.position,
                depth: newEntryData.depth,
                order: newEntryData.order
            });
            
            await TavernHelper.createLorebookEntries(bookName, [newEntryData]);
        }
        showToastr('success', `角色 ${safeCharName} 的描述已保存到世界书。`);
        return true;
    } catch (error) {
        logError(`保存世界书失败 for ${characterName}:`, error);
        showToastr('error', `保存角色 ${safeCharName} 到世界书失败。`);
        return false;
    }
}

export async function updateCharacterRosterLorebookEntry(processedCharacterNames, startFloor, endFloor) {
    if (!Array.isArray(processedCharacterNames)) return true;

    try {
        const context = SillyTavern.getContext();
        if (!context || !context.characterId) {
            logDebug('未选择角色，无法更新角色名册。');
            return false;
        }
        let chatIdentifier = state.currentChatFileIdentifier || '未知聊天';
        if (chatIdentifier === '未知聊天') return false;
        
        const cleanChatId = chatIdentifier.replace(/ imported/g, '');
        const rosterEntryComment = `Amily2角色总集-${cleanChatId}-角色总览`;

        let characterCardName = '未识别到该角色卡名称';
        try {
            const currentChar = context.characters[context.characterId];
            if (currentChar && currentChar.name) {
                characterCardName = currentChar.name.trim();
            }
        } catch (e) {
            logDebug('[CWB] 无法获取角色名称，使用默认值');
        }
        
        const initialContentPrefix = `此为当前角色卡【${characterCardName}】中登场的角色，AI需要根据剧情让以下角色在合适的时机登场：\n\n`;
        
        let bookName;
        if (state.worldbookTarget === 'custom' && state.customWorldBook) {
            bookName = state.customWorldBook;
        } else {
            bookName = await TavernHelper.getCurrentCharPrimaryLorebook();
        }

        if (!bookName) {
            showToastr('error', '未能确定要写入的世界书。请检查主世界书或自定义世界书设置。');
            return false;
        }

        let entries = (await TavernHelper.getLorebookEntries(bookName)) || [];
        let existingRosterEntry = entries.find(entry => 
            entry.comment === rosterEntryComment || 
            entry.comment === `Amily2角色总集-${chatIdentifier}-角色总览`
        );
        
        let existingNames = new Set();
        let oldStartFloor = 1;
        let oldEndFloor = 0;

        if (existingRosterEntry) {
            if (existingRosterEntry.content) {
                let contentToParse = existingRosterEntry.content.replace(initialContentPrefix, '');
                
                const floorMatch = contentToParse.match(/【前(\d+)楼角色世界书已更新完成】/);
                if (floorMatch && floorMatch[1]) {
                    oldEndFloor = parseInt(floorMatch[1], 10);
                }

                contentToParse.split('\n').forEach(line => {
                    if (line.trim().startsWith('[')) {
                        const nameMatch = line.match(/\[(.*?):/);
                        if (nameMatch && nameMatch[1]) {
                            existingNames.add(nameMatch[1].trim());
                        }
                    }
                });
            }
            const floorRangeKey = existingRosterEntry.keys.find(k => /^\d+-\d+$/.test(k));
            if (floorRangeKey) {
                [oldStartFloor] = floorRangeKey.split('-').map(Number);
            }
        }

        processedCharacterNames.forEach(name => existingNames.add(name.trim()));

        const newStartFloor = Math.min(oldStartFloor, startFloor + 1);
        const newEndFloor = Math.max(oldEndFloor, endFloor + 1);

        const newContent =
            initialContentPrefix +
            [...existingNames]
                .sort()
                .map(name => `[${name}: (详细查看绿灯角色条目)]`)
                .join('\n') + `\n\n{{// 本条勿动，【前${newEndFloor}楼角色世界书已更新完成】否则后续更新无法完成。}}`;

        const newFloorRange = `${newStartFloor}-${newEndFloor}`;

        const baseKeys = [`Amily2角色总集`, cleanChatId, `角色总览`];
        const newKeys = [...baseKeys, newFloorRange];

        const entryData = {
            content: newContent,
            keys: newKeys,
            type: 'constant',
            position: 'before_character_definition',
            depth: null,
            enabled: true,
            order: 9999,
            prevent_recursion: true,
        };

        if (existingRosterEntry) {
            await TavernHelper.setLorebookEntries(bookName, [
                { uid: existingRosterEntry.uid, comment: rosterEntryComment, ...entryData },
            ]);
        } else {
            await TavernHelper.createLorebookEntries(bookName, [
                { comment: rosterEntryComment, ...entryData },
            ]);
        }
        return true;
    } catch (error) {
        logError('更新角色名册条目时出错:', error);
        return false;
    }
}


export async function manageAutoCardUpdateLorebookEntry() {
    try {
        if (state.worldbookTarget === 'custom' && state.customWorldBook) {
            logDebug('[CWB] 使用自定义世界书模式，跳过角色总览条目的自动管理');
            return;
        }

        const context = SillyTavern.getContext();
        if (!context || !context.characterId) {
            logDebug('未选择角色，跳过世界书管理。');
            return;
        }
        const bookName = await getTargetWorldBook();
        if (!bookName) return;

        const entries = (await TavernHelper.getLorebookEntries(bookName)) || [];
        
        const currentChatId = state.currentChatFileIdentifier;
        if (!currentChatId || currentChatId.startsWith('unknown_chat')) {
            logError(`无效的聊天标识符 "${currentChatId}"。正在中止世界书管理。`);
            return;
        }
        const cleanChatId = currentChatId.replace(/ imported/g, '');

        let currentChatRosterExists = false;
        const entriesToUpdate = [];

        for (const entry of entries) {
            if (Array.isArray(entry.keys) && (entry.keys.includes('Amily2角色总集') || entry.keys.includes(cleanChatId) || entry.keys.includes(currentChatId))) {
                
                const isForCurrentChat = entry.keys.includes(cleanChatId) || entry.keys.includes(currentChatId);
                let shouldBeEnabled = isForCurrentChat;

                if (isForCurrentChat && entry.keys.includes('角色总览')) {
                    currentChatRosterExists = true;
                }

                if (entry.enabled !== shouldBeEnabled) {
                    entriesToUpdate.push({ uid: entry.uid, enabled: shouldBeEnabled });
                }
            }
        }

        if (entriesToUpdate.length > 0) {
            await TavernHelper.setLorebookEntries(bookName, entriesToUpdate);
            logDebug(`已为聊天: ${cleanChatId} 管理了 ${entriesToUpdate.length} 个世界书条目的状态。`);
        }

        if (!currentChatRosterExists) {
            logDebug(`未找到聊天 "${cleanChatId}" 的名册。正在触发创建。`);
            await updateCharacterRosterLorebookEntry([]);
        }

    } catch (error) {
        logError('管理世界书条目时出错:', error);
    }
}

export async function syncNovelLorebookEntries(bookName, entries) {
    if (!bookName || !Array.isArray(entries) || entries.length === 0) {
        logError('[CWB-NovelSync] 参数无效或条目为空');
        if (Array.isArray(entries) && entries.length === 0) {
            showToastr('warning', '[小说处理] API回复中未找到有效条目。');
        }
        return;
    }

    try {
        const allEntries = (await TavernHelper.getLorebookEntries(bookName)) || [];
        const managedEntries = allEntries.filter(e => e.comment?.startsWith(`[Amily2小说处理]`));
        
        const entriesToUpdate = [];
        const entriesToCreate = [];
        let maxPart = 0;
        managedEntries.forEach(entry => {
            const match = entry.comment.match(/章节内容概述-第(\d+)部分/);
            if (match && parseInt(match[1], 10) > maxPart) {
                maxPart = parseInt(match[1], 10);
            }
        });
        let nextPart = maxPart + 1;

        for (const entry of entries) {
            const { title, content } = entry;

            if (title === '章节内容概述') {
                const loreData = {
                    keys: [`小说处理`, title, `第${nextPart}部分`],
                    content: content,
                    comment: `[Amily2小说处理] ${title}-第${nextPart}部分`,
                    enabled: true,
                    order: 100,
                    position: 'before_char',
                };
                entriesToCreate.push(loreData);
                nextPart++;
            } else {
                const existingEntry = managedEntries.find(e => e.comment === `[Amily2小说处理] ${title}`);
                
                const loreData = {
                    keys: [`小说处理`, title],
                    content: content,
                    comment: `[Amily2小说处理] ${title}`,
                    enabled: true,
                    order: 100,
                    position: 'before_char',
                };

                if (existingEntry) {
                    entriesToUpdate.push({ uid: existingEntry.uid, ...loreData });
                } else {
                    entriesToCreate.push(loreData);
                }
            }
        }

        if (entriesToUpdate.length > 0) {
            await TavernHelper.setLorebookEntries(bookName, entriesToUpdate);
            showToastr('info', `[小说处理] 更新了 ${entriesToUpdate.length} 个世界书条目。`);
        }
        if (entriesToCreate.length > 0) {
            await TavernHelper.createLorebookEntries(bookName, entriesToCreate);
            showToastr('success', `[小说处理] 创建了 ${entriesToCreate.length} 个新世界书条目。`);
        }

    } catch (error) {
        logError('同步小说世界书条目时出错:', error);
        showToastr('error', '同步世界书失败，详情请查看控制台。');
    }
}

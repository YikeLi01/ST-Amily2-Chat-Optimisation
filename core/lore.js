import { extension_settings, getContext } from "/scripts/extensions.js";
import { characters, eventSource, event_types } from "/script.js";
import { loadWorldInfo, createNewWorldInfo, createWorldInfoEntry, saveWorldInfo, world_names } from "/scripts/world-info.js";
import { compatibleWriteToLorebook, safeLorebooks, safeCharLorebooks, safeLorebookEntries, isTavernHelperAvailable } from "./tavernhelper-compatibility.js";
import { extensionName } from "../utils/settings.js";


export const LOREBOOK_PREFIX = "Amily2档案-";
export const DEDICATED_LOREBOOK_NAME = "Amily2号-国史馆";
export const INTRODUCTORY_TEXT =
  "【Amily2号自动档案】\n此卷宗由Amily2号优化助手自动生成并维护，记录核心事件脉络。\n---\n";

export async function getChatIdentifier() {
  let attempts = 0;
  const maxAttempts = 50;
  const interval = 100;

  while (attempts < maxAttempts) {
    try {
      const context = getContext();
      if (context && context.characterId) {
        const character = characters[context.characterId];
        if (character && character.avatar) {
          return `char-${character.avatar.replace(/\.(png|webp|jpg|jpeg|gif)$/, "")}`;
        }
        return `char-${context.characterId}`;
      }
      if (context && context.chat_filename) {
        const fileName = context.chat_filename.split(/[\\/]/).pop();
        return fileName.replace(/\.jsonl?$/, "");
      }
    } catch (error) {
      console.warn(
        `[Amily2-户籍管理处] 等待上下文时发生轻微错误 (尝试次数 ${attempts + 1}):`,
        error.message,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
    attempts++;
  }

  console.error("[Amily2-国史馆] 户籍管理处在长时间等待后，仍无法确定户籍。");
  toastr.warning(
    "Amily2号无法确定当前聊天身份，世界书功能将受影响。",
    "上下文错误",
  );
  return "unknown_chat_timeout";
}

export async function findLatestSummaryLore(lorebookName, chatIdentifier) {
  try {
    const bookData = await loadWorldInfo(lorebookName);
    if (!bookData || !bookData.entries) {
      return null;
    }
    const entriesArray = Object.values(bookData.entries);
    const uniqueLoreName = `${LOREBOOK_PREFIX}${chatIdentifier}`;
    return (
      entriesArray.find(
        (entry) => entry.comment === uniqueLoreName && !entry.disable,
      ) || null
    );
  } catch (error) {
    console.error(
      `[Amily2-国史馆] 钦差大臣在 '${lorebookName}' 检索时发生错误:`,
      error,
    );
    return null;
  }
}

export async function getCombinedWorldbookContent(lorebookName) {
  if (!lorebookName) return "";
  try {
    const bookData = await loadWorldInfo(lorebookName);
    if (!bookData || !bookData.entries) {
      return "";
    }
    const activeContents = Object.values(bookData.entries)
      .filter((entry) => !entry.disable)
      .map((entry) => `[条目: ${entry.comment || "无标题"}]\n${entry.content}`);
    return activeContents.join("\n\n---\n\n");
  } catch (error) {
    console.error(
      `[Amily2-国史馆] 钦差大臣在整合 '${lorebookName}' 时发生错误:`,
      error,
    );
    toastr.error(`读取世界书 '${lorebookName}' 失败!`, "档案整合错误");
    return "";
  }
}

async function refreshWorldbookListOnly(newBookName = null) {
  console.log("[Amily2号-工部-v1.3] 执行“圣谕广播”式UI更新...");
  try {
    if (newBookName) {
      if (Array.isArray(world_names) && !world_names.includes(newBookName)) {
        world_names.push(newBookName);
        world_names.sort();
        console.log(`[Amily2号-工部] 已将《${newBookName}》注入前端数据模型。`);
      } else {
         console.log(`[Amily2号-工部] 《${newBookName}》已存在于数据模型中，跳过注入。`);
      }
    }

    if (
      eventSource &&
      typeof eventSource.emit === "function" &&
      event_types.CHARACTER_PAGE_LOADED
    ) {
      console.log(`[Amily2号-工部] 正在广播事件: ${event_types.CHARACTER_PAGE_LOADED}`);
      eventSource.emit(event_types.CHARACTER_PAGE_LOADED);
      console.log("[Amily2号-工部] “character_page_loaded”事件已广播，UI应已响应刷新。");
    } else {
      console.error("[Amily2号] 致命错误: eventSource 或 event_types.CHARACTER_PAGE_LOADED 未找到。无法广播刷新事件。");
      toastr.error("Amily2号无法触发UI刷新。", "核心事件系统缺失");
    }
  } catch (error) {
    console.error("[Amily2号-工部] “圣谕广播”式刷新失败:", error);
  }
}

export async function writeSummaryToLorebook(pendingData) {
    if (!pendingData || !pendingData.summary || !pendingData.sourceAiMessageTimestamp || !pendingData.settings) {
        console.warn("[Amily2-国史馆] 接到一份残缺的待办文书，写入任务已中止。", pendingData);
        return;
    }

    const context = getContext();
    const chat = context.chat;
    let isSourceMessageValid = false;
    let sourceMessageCandidate = null;
    for (let i = chat.length - 2; i >= 0; i--) {
        if (!chat[i].is_user) { sourceMessageCandidate = chat[i]; break; }
    }
    if (sourceMessageCandidate && sourceMessageCandidate.send_date === pendingData.sourceAiMessageTimestamp) {
        isSourceMessageValid = true;
    }
    if (!isSourceMessageValid) {
        console.log("[Amily2号-逆时寻踪] 裁决: 源消息已被修改或删除，遵旨废黜过时总结。");
        return;
    }

    const { summary: summaryToCommit, settings } = pendingData;

    console.groupCollapsed(`[Amily2号-存档任务-v21.0 最终圣旨版] ${new Date().toLocaleTimeString()}`);
    console.time("总结写入总耗时");

    try {
        const chatIdentifier = await getChatIdentifier();
        const character = characters[context.characterId];
        let targetLorebookName = null;
        let isNewBook = false;
        switch (settings.target) {
            case "character_main":
                targetLorebookName = character?.data?.extensions?.world;
                if (!targetLorebookName) {
                    toastr.warning("角色未绑定主世界书，总结写入任务已中止。", "Amily2号");
                    console.groupEnd();
                    return;
                }
                break;
            case "dedicated":
                targetLorebookName = `${DEDICATED_LOREBOOK_NAME}-${chatIdentifier}`;
                break;
            default:
                toastr.error(`收到未知的写入指令: "${settings.target}"`, "Amily2号");
                console.groupEnd();
                return;
        }

        if (!world_names.includes(targetLorebookName)) {
            await createNewWorldInfo(targetLorebookName);
            isNewBook = true;
        }

        const uniqueLoreName = `${LOREBOOK_PREFIX}${chatIdentifier}`;
        const bookData = await loadWorldInfo(targetLorebookName);
        if (!bookData) {
            toastr.error(`无法加载世界书《${targetLorebookName}》`, "Amily2号");
            console.groupEnd();
            return;
        }

        const existingEntry = Object.values(bookData.entries).find(e => e.comment === uniqueLoreName && !e.disable);

        if (existingEntry) {
            const existingContent = existingEntry.content.replace(INTRODUCTORY_TEXT, "").trim();
            const lines = existingContent ? existingContent.split("\n") : [];
            const nextNumber = lines.length + 1;
            existingEntry.content += `\n${nextNumber}. ${summaryToCommit}`;
        } else {

            const positionMap = {
                'before_char': 0, 'after_char': 1, 'before_an': 2,
                'after_an': 3, 'at_depth': 4
            };

            const finalKeywords = settings.keywords.split(',').map(k => k.trim()).filter(Boolean);
            const isConstant = settings.activationMode === 'always';
            const newEntry = createWorldInfoEntry(targetLorebookName, bookData);
            Object.assign(newEntry, {
                comment: uniqueLoreName,
                content: `${INTRODUCTORY_TEXT}1. ${summaryToCommit}`,
                key: finalKeywords,
                constant: isConstant,
                position: positionMap[settings.insertionPosition] ?? 4,
                depth: settings.depth,
                disable: false,
            });
        }


        await saveWorldInfo(targetLorebookName, bookData, true);
        console.log(`[史官司] 总结已遵旨写入《${targetLorebookName}》文件。`);

        if (isNewBook) {
            await refreshWorldbookListOnly(targetLorebookName);
            toastr.success(`已创建并写入新档案《${targetLorebookName}》！`, "Amily2号");
        }
    } catch (error) {
        console.error("[Amily2号-写入失败] 写入流程发生意外错误:", error);
        toastr.error("后台写入总结时发生错误。", "Amily2号");
    } finally {
        console.timeEnd("总结写入总耗时");
        console.groupEnd();
    }
}

export async function getOptimizationWorldbookContent() {
    const settings = extension_settings[extensionName];
    if (!settings || !settings.modal_wbEnabled) {
        return '';
    }

    try {
        let bookNames = [];
        if (settings.modal_wbSource === 'manual') {
            bookNames = settings.modal_amily2_wb_selected_worldbooks || [];
        } else { // 'character' source
            const charLorebooks = await safeCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
        }

        if (bookNames.length === 0) {
            console.log('[Amily2-正文优化] No world books selected or linked for optimization.');
            return '';
        }

        let allEntries = [];
        for (const bookName of bookNames) {
            if (bookName) {
                const entries = await safeLorebookEntries(bookName);
                if (entries?.length) {
                    entries.forEach(entry => allEntries.push({ ...entry, bookName }));
                }
            }
        }

        const selectedEntriesConfig = settings.modal_amily2_wb_selected_entries || {};

        const userEnabledEntries = allEntries.filter(entry => {
            // Entry must be enabled in the lorebook itself
            if (!entry.enabled) return false;
            
            // Check against our UI selection
            const bookConfig = selectedEntriesConfig[entry.bookName];
            return bookConfig ? bookConfig.includes(String(entry.uid)) : false;
        });

        if (userEnabledEntries.length === 0) {
            console.log('[Amily2-正文优化] No entries are selected for optimization in the chosen world books.');
            return '';
        }

        const finalContent = userEnabledEntries.map(entry => entry.content).filter(Boolean);
        const combinedContent = finalContent.join('\n\n---\n\n');
        
        console.log(`[Amily2-正文优化] Loaded ${userEnabledEntries.length} world book entries, total length: ${combinedContent.length}`);
        return combinedContent;

    } catch (error) {
        console.error(`[Amily2-正文优化] Processing world book content failed:`, error);
        return '';
    }
}


export async function getPlotOptimizedWorldbookContent(context, apiSettings) {
    const panel = $('#amily2_plot_optimization_panel');
    let liveSettings = {};

    if (panel.length > 0) {
        liveSettings.worldbookEnabled = panel.find('#amily2_opt_worldbook_enabled').is(':checked');
        liveSettings.worldbookSource = panel.find('input[name="amily2_opt_worldbook_source"]:checked').val() || 'character';
        
        liveSettings.selectedWorldbooks = [];
        if (liveSettings.worldbookSource === 'manual') {
            panel.find('#amily2_opt_worldbook_checkbox_list input[type="checkbox"]:checked').each(function() {
                liveSettings.selectedWorldbooks.push($(this).val());
            });
        }

        liveSettings.worldbookCharLimit = parseInt(panel.find('#amily2_opt_worldbook_char_limit').val(), 10) || 60000;

        let enabledEntries = {};
        panel.find('#amily2_opt_worldbook_entry_list_container input[type="checkbox"]').each(function() {
            if ($(this).is(':checked')) {
                const bookName = $(this).data('book');
                const uid = parseInt($(this).data('uid'));
                if (!enabledEntries[bookName]) {
                    enabledEntries[bookName] = [];
                }
                enabledEntries[bookName].push(uid);
            }
        });
        liveSettings.enabledWorldbookEntries = enabledEntries;
    } else {
        console.warn('[剧情优化大师] 未找到设置面板，世界书功能将回退到使用已保存的设置。');
        liveSettings = {
            worldbookEnabled: apiSettings.worldbookEnabled,
            worldbookSource: apiSettings.worldbookSource,
            selectedWorldbooks: apiSettings.selectedWorldbooks,
            worldbookCharLimit: apiSettings.worldbookCharLimit,
            enabledWorldbookEntries: apiSettings.enabledWorldbookEntries,
        };
    }

    if (!liveSettings.worldbookEnabled) {
        return '';
    }

    if (!isTavernHelperAvailable() || !context) {
        console.warn('[剧情优化大师] TavernHelper API 或 context 未提供，无法获取世界书内容。');
        return '';
    }

    try {
        let bookNames = [];
        
        if (liveSettings.worldbookSource === 'manual') {
            bookNames = liveSettings.selectedWorldbooks;
            if (bookNames.length === 0) return '';
        } else {
            const charLorebooks = await safeCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
            if (bookNames.length === 0) return '';
        }

        let allEntries = [];
        for (const bookName of bookNames) {
            if (bookName) {
                const entries = await safeLorebookEntries(bookName);
                if (entries?.length) {
                    entries.forEach(entry => allEntries.push({ ...entry, bookName }));
                }
            }
        }

        if (allEntries.length === 0) return '';
        
        const enabledEntriesMap = liveSettings.enabledWorldbookEntries || {};
        const userEnabledEntries = allEntries.filter(entry => {
            if (!entry.enabled) return false;
            const bookConfig = enabledEntriesMap[entry.bookName];
            return bookConfig ? bookConfig.includes(entry.uid) : false;
        });

        if (userEnabledEntries.length === 0) return '';
        
        const chatHistory = context.chat.map(message => message.mes).join('\n').toLowerCase();
        const getEntryKeywords = (entry) => [...new Set([...(entry.key || []), ...(entry.keys || [])])].map(k => k.toLowerCase());

        const blueLightEntries = userEnabledEntries.filter(entry => entry.type === 'constant');
        let pendingGreenLights = userEnabledEntries.filter(entry => entry.type !== 'constant');
        
        const triggeredEntries = new Set([...blueLightEntries]);

        while (true) {
            let hasChangedInThisPass = false;
            
            const recursionSourceContent = Array.from(triggeredEntries)
                .filter(e => !e.prevent_recursion)
                .map(e => e.content)
                .join('\n')
                .toLowerCase();
            const fullSearchText = `${chatHistory}\n${recursionSourceContent}`;

            const nextPendingGreenLights = [];
            
            for (const entry of pendingGreenLights) {
                const keywords = getEntryKeywords(entry);
                let isTriggered = keywords.length > 0 && keywords.some(keyword => 
                    entry.exclude_recursion ? chatHistory.includes(keyword) : fullSearchText.includes(keyword)
                );

                if (isTriggered) {
                    triggeredEntries.add(entry);
                    hasChangedInThisPass = true;
                } else {
                    nextPendingGreenLights.push(entry);
                }
            }
            
            if (!hasChangedInThisPass) break;
            
            pendingGreenLights = nextPendingGreenLights;
        }

        const finalContent = Array.from(triggeredEntries).map(entry => entry.content).filter(Boolean);
        if (finalContent.length === 0) return '';

        const combinedContent = finalContent.join('\n\n---\n\n');
        
        const limit = liveSettings.worldbookCharLimit;
        if (combinedContent.length > limit) {
            console.log(`[剧情优化大师] 世界书内容 (${combinedContent.length} chars) 超出限制 (${limit} chars)，将被截断。`);
            return combinedContent.substring(0, limit);
        }

        return combinedContent;

    } catch (error) {
        console.error(`[剧情优化大师] 处理世界书逻辑时出错:`, error);
        return '';
    }
}


export async function writeToLorebookWithTavernHelper(targetLorebookName, entryComment, contentUpdateCallback, options = {}) {
    console.log('[国史馆-兼容性] writeToLorebookWithTavernHelper 接收到的选项:', options);

    try {
        const success = await compatibleWriteToLorebook(targetLorebookName, entryComment, contentUpdateCallback, options);
        
        if (success) {
            console.log(`[Amily2-国史馆] 已通过兼容性层将内容成功写入《${targetLorebookName}》的条目 "${entryComment}"。`);

            if (eventSource && typeof eventSource.emit === "function" && event_types.CHARACTER_PAGE_LOADED) {
                eventSource.emit(event_types.CHARACTER_PAGE_LOADED);
            }
            
            return true;
        } else {
            throw new Error("兼容性层写入失败，请检查控制台日志。");
        }
    } catch (error) {
        console.error(`[Amily2-国史馆] 兼容性写入失败:`, error);
        toastr.error(`写入世界书失败: ${error.message}`, "Amily2号-国史馆");
        return false;
    }
}


export async function manageLorebookEntriesForChat() {
    if (!isTavernHelperAvailable()) {
        console.warn("[Amily2-国史馆] TavernHelper API 未找到，无法管理条目状态。");
        return;
    }

    try {
        const chatIdentifier = await getChatIdentifier();
        if (!chatIdentifier || chatIdentifier.startsWith("unknown_chat")) {
            console.error(`[Amily2-国史馆] 无法获取有效的聊天标识符，中止条目状态管理。`);
            return;
        }

        const context = getContext();
        if (!context || !context.characterId) {
            console.log("[Amily2-国史馆] 未选择任何角色，跳过世界书管理。");
            return;
        }

        const charLorebooks = await safeCharLorebooks({ type: 'all' });
        const bookNames = [];
        if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
        if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);

        const dedicatedBookName = `${DEDICATED_LOREBOOK_NAME}-${chatIdentifier}`;
        if (!bookNames.includes(dedicatedBookName)) {
            bookNames.push(dedicatedBookName);
        }

        for (const bookName of bookNames) {
            if (!world_names.includes(bookName)) continue; 

            const entries = await safeLorebookEntries(bookName);
            const entriesToUpdate = [];

            for (const entry of entries) {
                if (entry.comment && entry.comment.startsWith(LOREBOOK_PREFIX)) {
                    const isForCurrentChat = entry.comment.includes(chatIdentifier);
                    if (isForCurrentChat && entry.disable) {
                        entriesToUpdate.push({ uid: entry.uid, enabled: true });
                    } else if (!isForCurrentChat && !entry.disable) {
                        entriesToUpdate.push({ uid: entry.uid, enabled: false });
                    }
                }
            }

            if (entriesToUpdate.length > 0) {
                const success = await safeUpdateLorebookEntries(bookName, entriesToUpdate);
                if (success) {
                    console.log(`[Amily2-国史馆] 已为《${bookName}》更新了 ${entriesToUpdate.length} 个条目的状态以匹配当前聊天: ${chatIdentifier}`);
                }
            }
        }

    } catch (error) {
        console.error("[Amily2-国史馆] 管理世界书条目状态时发生错误:", error);
    }
}

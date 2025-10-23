import { getContext, extension_settings } from "/scripts/extensions.js";
import { loadWorldInfo } from "/scripts/world-info.js";
import { saveChat } from "/script.js";
import { renderTables } from '../../ui/table-bindings.js';
import { updateOrInsertTableInChat } from '../../ui/message-table-renderer.js';
import { extensionName } from "../../utils/settings.js";
import { updateTableFromText, getBatchFillerRuleTemplate, getBatchFillerFlowTemplate, convertTablesToCsvString, saveStateToMessage, getMemoryState, clearHighlights } from './manager.js';
import { getPresetPrompts, getMixedOrder } from '../../PresetSettings/index.js';
import { callAI, generateRandomSeed } from '../api.js';
import { callNccsAI } from '../api/NccsApi.js';
import { extractBlocksByTags, applyExclusionRules } from '../utils/rag-tag-extractor.js';
import { safeLorebookEntries } from '../tavernhelper-compatibility.js';


async function getWorldBookContext() {
    const settings = extension_settings[extensionName];

    if (!settings.table_worldbook_enabled) {
        return '';
    }

    const selectedEntriesByBook = settings.table_selected_entries || {};
    const booksToInclude = Object.keys(selectedEntriesByBook);
    const selectedEntryUids = new Set(Object.values(selectedEntriesByBook).flat());

    if (booksToInclude.length === 0 || selectedEntryUids.size === 0) {
        return '';
    }

    let allEntries = [];
    for (const bookName of booksToInclude) {
        try {
            const entries = await safeLorebookEntries(bookName);
            if (entries?.length) {
                entries.forEach(entry => allEntries.push({ ...entry, bookName }));
            }
        } catch (error) {
            console.error(`[Amily2-副API] Error loading entries for world book: ${bookName}`, error);
        }
    }

    const userEnabledEntries = allEntries.filter(entry => {
        return entry && selectedEntryUids.has(String(entry.uid));
    });

    if (userEnabledEntries.length === 0) {
        return '';
    }

    let content = userEnabledEntries.map(entry => 
        `[来源：世界书，条目名字：${entry.comment || '无标题条目'}]\n${entry.content}`
    ).join('\n\n');
    
    const maxChars = settings.table_worldbook_char_limit || 30000;
    if (content.length > maxChars) {
        content = content.substring(0, maxChars);
        const lastNewline = content.lastIndexOf('\n');
        if (lastNewline !== -1) {
            content = content.substring(0, lastNewline);
        }
        content += '\n[...内容已截断]';
    }

    return content.trim() ? `<世界书>\n${content.trim()}\n</世界书>` : '';
}

export async function fillWithSecondaryApi(latestMessage, forceRun = false) {
    clearHighlights();

    const context = getContext();
    if (context.chat.length <= 1) {
        console.log("[Amily2-副API] 聊天刚开始，跳过本次自动填表。");
        return;
    }

    const settings = extension_settings[extensionName];

    const fillingMode = settings.filling_mode || 'main-api';
    if (fillingMode !== 'secondary-api' && !forceRun) {
        log('当前非分步填表模式，且未强制执行，跳过。', 'info');
        return; 
    }

    if (window.AMILY2_SYSTEM_PARALYZED === true) {
        console.error("[Amily2-制裁] 系统完整性已受损，所有外交活动被无限期中止。");
        return;
    }

    const { apiUrl, apiKey, model, temperature, maxTokens, forceProxyForCustomApi } = settings;
    if (!apiUrl || !model) {
        if (!window.secondaryApiUrlWarned) {
            toastr.error("主API的URL或模型未配置，分步填表功能无法启动。", "Amily2-分步填表");
            window.secondaryApiUrlWarned = true;
        }
        return;
    }

    try {
        let textToProcess = latestMessage.mes;
        if (!textToProcess || !textToProcess.trim()) {
            console.log("[Amily2-副API] 消息内容为空，跳过填表任务。");
            return;
        }

        let tagsToExtract = [];
        let exclusionRules = [];
        if (settings.table_independent_rules_enabled) {
            tagsToExtract = (settings.table_tags_to_extract || '').split(',').map(t => t.trim()).filter(Boolean);
            exclusionRules = settings.table_exclusion_rules || [];
        }

        if (tagsToExtract.length > 0) {
            const blocks = extractBlocksByTags(textToProcess, tagsToExtract);
            textToProcess = blocks.join('\n\n');
        }
        textToProcess = applyExclusionRules(textToProcess, exclusionRules);

        if (!textToProcess.trim()) {
            console.log("[Amily2-副API] 规则处理后消息内容为空，跳过填表任务。");
            return;
        }

        const context = getContext();
        const userName = context.name1 || '用户';
        const characterName = context.name2 || '角色';

        const chat = context.chat;
        
        let lastUserMessage = null;
        let lastUserMessageIndex = -1;
        for (let i = chat.length - 2; i >= 0; i--) {
            if (chat[i].is_user) {
                lastUserMessage = chat[i];
                lastUserMessageIndex = i;
                break;
            }
        }

        const currentInteractionContent = (lastUserMessage ? `${userName}（用户）最新消息：${lastUserMessage.mes}\n` : '') + 
                                          `${characterName}（AI）最新消息，[核心处理内容]：${textToProcess}`;

        let mixedOrder;
        try {
            const savedOrder = localStorage.getItem('amily2_prompt_presets_v2_mixed_order');
            if (savedOrder) {
                mixedOrder = JSON.parse(savedOrder);
            }
        } catch (e) {
            console.error("[副API填表] 加载混合顺序失败:", e);
        }


        const order = getMixedOrder('secondary_filler') || [];


        const presetPrompts = await getPresetPrompts('secondary_filler');
        
        const messages = [
            { role: 'system', content: generateRandomSeed() }
        ];

        const worldBookContext = await getWorldBookContext();

        const ruleTemplate = getBatchFillerRuleTemplate();
        const flowTemplate = getBatchFillerFlowTemplate();
        const currentTableDataString = convertTablesToCsvString();
        const finalFlowPrompt = flowTemplate.replace('{{{Amily2TableData}}}', currentTableDataString);

        let promptCounter = 0; 
        for (const item of order) {
            if (item.type === 'prompt') {
                if (presetPrompts && presetPrompts[promptCounter]) {
                    messages.push(presetPrompts[promptCounter]);
                    promptCounter++; 
                }
            } else if (item.type === 'conditional') {
                switch (item.id) {
                    case 'worldbook':
                        if (worldBookContext) {
                            messages.push({ role: "system", content: worldBookContext });
                        }
                        break;
                    case 'contextHistory':
                        const contextReadingLevel = settings.context_reading_level || 4;
                        const historyMessagesToGet = contextReadingLevel > 2 ? contextReadingLevel - 2 : 0;

                        if (historyMessagesToGet > 0) {
                            const historyEndIndex = lastUserMessageIndex !== -1 ? lastUserMessageIndex : chat.length - 1;
                            const historyContext = await getHistoryContext(historyMessagesToGet, historyEndIndex, tagsToExtract, exclusionRules);
                            if (historyContext) {
                                messages.push({ role: "system", content: historyContext });
                            }
                        }
                        break;
                    case 'ruleTemplate':
                        messages.push({ role: "system", content: ruleTemplate });
                        break;
                    case 'flowTemplate':
                        messages.push({ role: "system", content: finalFlowPrompt });
                        break;
                    case 'coreContent':
                        messages.push({ role: 'user', content: `请严格根据以下"最新消息"中的内容进行填写表格，并按照指定的格式输出，不要添加任何额外信息。\n\n<最新消息>\n${currentInteractionContent}\n</最新消息>` });
                        break;
                    case 'thinkingFramework':
                        messages.push({ role: "system", content: `# 通用表格转换思考框架
## 核心原则
1. 将叙事内容转化为结构化数据
2. 聚焦关键元素变更
3. 保证数据真实性与一致性
## 思考流程 (<thinking></thinking>)
请严格按此框架思考并在<thinking>标签内输出：
<thinking>
1. 【时间地点分析】
   - 当前时态：现在是什么年份/季节/日期？具体几点几分？
   - 空间定位：故事发生在什么场景(建筑/自然等)？具体位置？
   - 变更检测：相比之前，时间地点是否有显著变化？
2. 【角色动态分析】
   - 在场角色：当前场景有哪些角色存在？
   - 新增角色：是否有首次出现的角色？
   - 角色变化：
     - 外貌特征：体型/发型/穿戴着装
     - 状态变化：受伤/情绪/随身物品
     - 关系变动：新建立/改变的关系
   - 角色语录：有否揭示角色背景的关键对话？
3. 【任务进展追踪】
   - 活跃任务：正在进行哪些重要事项？
   - 新任务：是否产生新的承诺/任务？
   - 状态更新：任何任务进度变化？
   - 任务闭环：有无完成或失败的任务？
4. 【关键物品识别】
   - 特殊物品：有无意义重大的物品出现？
   - 物品变动：
     - 获取/丢失物品
     - 使用/损耗情况
     - 所有权变更
5. 【系统指令响应】 (仅处理明确指令)
   - 识别：是否有来自叙事者的指令？(括号标注)
   - 响应：完全执行/拒绝无效指令
6. 【逻辑校验】
   - 矛盾解决：处理相互冲突的信息
   - 数据溯源：标注信息提取位置(例：第3段)
   - 过滤机制：忽略临时/不重要的描写
   - 必须填表：无论表格是否为新，都需要结合正文与现有表格内容，进行更新。
   - 必须填充：当内容为"未知"或者"无"的表格，必须结合现知内容补全。
7. 【避错填表】
   - 列出当前所有表以及行数，避免信息错误填充。
## 通用输出规范
- 时间格式：YYYY-MM-DD HH:MM
- 地点格式：[建筑]>[具体位置] (例：城堡>东侧塔楼)
- 角色引用：统一使用全名首次出现
- 状态标记：使用标准状态词(进行中/已完成/已取消)
-   **插入行示例**: 
insertRow(0, {0: "2025-09-04", 1: "晚上", 2: "19:30", 3: "图书馆", 4: "艾克"})
-   **删除行示例**:
deleteRow(1, 5)
-   **更新行示例**:
updateRow(1, 0, {8: "警惕/怀疑"})
</thinking>
<Amily2Edit>
<!--
(这里是你的填表内容)
-->
</Amily2Edit>
<finsh>The form filling work has been completed.</finsh>` });
                        break;
                }
            }
        }

        const fillingMode = settings.filling_mode || 'main-api';
        if (fillingMode === 'secondary-api') {
            console.groupCollapsed(`[Amily2 分步填表] 即将发送至 API 的内容`);
            console.dir(messages);
            console.groupEnd();
        }

        let rawContent;
        if (settings.nccsEnabled) {
            console.log('[Amily2-副API] 使用 Nccs API 进行分步填表...');
            rawContent = await callNccsAI(messages);
        } else {
            console.log('[Amily2-副API] 使用默认 API 进行分步填表...');
            rawContent = await callAI(messages);
        }

        if (!rawContent) {
            console.error('[Amily2-副API] 未能获取AI响应内容。');
            return;
        }

        console.log("[Amily2号-副API-原始回复]:", rawContent);

        updateTableFromText(rawContent);

        const currentContext = getContext();
        if (currentContext.chat && currentContext.chat.length > 0) {
            const lastMessage = currentContext.chat[currentContext.chat.length - 1];
            if (saveStateToMessage(getMemoryState(), lastMessage)) {
                saveChat();
                renderTables();
                updateOrInsertTableInChat();
                return;
            }
        }
        saveChatDebounced(); 

    } catch (error) {
        console.error(`[Amily2-副API] 发生严重错误:`, error);
        toastr.error(`副API填表失败: ${error.message}`, "严重错误");
    }
}

async function getHistoryContext(messagesToFetch, historyEndIndex, tagsToExtract, exclusionRules) {
    const context = getContext();
    const chat = context.chat;
    
    if (!chat || chat.length === 0 || messagesToFetch <= 0) {
        return null;
    }

    const historyUntil = Math.max(0, historyEndIndex); 
    const messagesToExtract = Math.min(messagesToFetch, historyUntil);
    const startIndex = Math.max(0, historyUntil - messagesToExtract);
    const endIndex = historyUntil;

    const historySlice = chat.slice(startIndex, endIndex);
    const userName = context.name1 || '用户';
    const characterName = context.name2 || '角色';

    const messages = historySlice.map((msg, index) => {
        let content = msg.mes;

        if (!msg.is_user && tagsToExtract && tagsToExtract.length > 0) {
            const blocks = extractBlocksByTags(content, tagsToExtract);
            content = blocks.join('\n\n');
        }
        
        if (content && exclusionRules) {
            content = applyExclusionRules(content, exclusionRules);
        }

        if (!content.trim()) return null;
        
        return {
            floor: startIndex + index + 1, 
            author: msg.is_user ? userName : characterName,
            authorType: msg.is_user ? 'user' : 'char',
            content: content.trim()
        };
    }).filter(Boolean);
    
    if (messages.length === 0) {
        return null;
    }

    const formattedHistory = messages.map(m => `【第 ${m.floor} 楼】 ${m.author}: ${m.content}`).join('\n');

    return `<对话记录>\n${formattedHistory}\n</对话记录>`;
}

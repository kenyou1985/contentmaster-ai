import React, { useState } from 'react';
import { ToolMode, NicheType, ApiProvider } from '../types';
import { NICHES } from '../constants';
import { streamContentGeneration, initializeGemini } from '../services/geminiService';
import { FileText, Maximize2, RefreshCw, Scissors, ArrowRight, Copy, ChevronDown } from 'lucide-react';

interface ToolsProps {
  apiKey: string;
  provider: ApiProvider;
}

export const Tools: React.FC<ToolsProps> = ({ apiKey, provider }) => {
  const [mode, setMode] = useState<ToolMode>(ToolMode.REWRITE);
  const [niche, setNiche] = useState<NicheType>(NicheType.TCM_METAPHYSICS); // Niche awareness
  const [inputText, setInputText] = useState('');
  const [outputText, setOutputText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);

  // 清理Markdown格式符号，输出纯文本（保留编号格式）
  const cleanMarkdownFormat = (text: string, mode?: ToolMode): string => {
    if (!text) return '';
    let cleaned = text
      // 移除Markdown标题标记
      .replace(/^#{1,6}\s+/gm, '')
      // 移除所有Markdown特殊符号
      .replace(/\*\*/g, '') // 移除 **粗体**
      .replace(/\*/g, '') // 移除 *斜体*（但要保留编号中的点，所以先处理**）
      .replace(/__/g, '') // 移除 __粗体__
      .replace(/_/g, '') // 移除 _斜体_
      .replace(/~~/g, '') // 移除 ~~删除线~~
      .replace(/~/g, '') // 移除 ~删除线~
      .replace(/`/g, '') // 移除 `代码`
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // 移除链接格式，保留文本
      .replace(/\[([^\]]+)\]/g, '$1') // 移除引用链接格式
      .replace(/<[^>]+>/g, '') // 移除HTML标签
      // 移除无序列表标记（保留编号格式）
      .replace(/^\s*[-*+•]\s+/gm, '');
    
    // 对于摘要模式，保留编号格式（1. 2. 3.等）
    if (mode === ToolMode.SUMMARIZE) {
      // 不移除编号，只清理其他格式
    } else {
      // 其他模式移除编号格式
      cleaned = cleaned.replace(/^\s*\d+\.\s+/gm, '');
    }
    
    return cleaned
      // 清理多余空行
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim();
  };

  // 检查是否有提前的收尾词（字数不足时不应该出现）
  const hasPrematureEnding = (text: string): boolean => {
    const endingKeywords = [
      /下課/i,
      /下课/i,
      /散會/i,
      /散会/i,
      /下期再見/i,
      /下期再见/i,
      /今天就到這/i,
      /今天就到这/i,
      /咱們下次/i,
      /咱们下次/i,
    ];
    return endingKeywords.some(pattern => pattern.test(text));
  };

  // 检查内容是否完整（是否有明确的结尾）
  const isContentComplete = (text: string, mode: ToolMode, originalLength: number): boolean => {
    if (mode === ToolMode.SUMMARIZE) {
      // 摘要模式：检查是否有标签部分（表示完整输出）
      return text.includes('熱門標籤') || text.includes('#');
    }
    
    // 其他模式：检查字数和结尾完整性
    const length = text.length;
    const hasProperEnding = /[。！？.!?]$/.test(text.trim()); // 以标点结尾
    const notTruncated = !text.endsWith('...') && !text.endsWith('…');
    
    if (mode === ToolMode.REWRITE || mode === ToolMode.POLISH) {
      // 改写和润色：必须字数>=原文的90%才认为完整
      // 如果字数不足但出现了收尾词，说明提前结束了，需要继续
      const reachedMinimum = length >= originalLength * 0.9;
      const reachedTarget = length >= originalLength * 0.95;
      
      // 如果字数不足90%，即使有收尾标点也不算完整
      if (!reachedMinimum) {
        return false;
      }
      
      // 字数达到90-95%，且有标点结尾，才算完整
      return reachedTarget && hasProperEnding && notTruncated;
    } else if (mode === ToolMode.EXPAND) {
      // 扩写：必须字数>=1.4倍才认为接近完成
      const reachedMinimum = length >= originalLength * 1.4;
      const reachedTarget = length >= originalLength * 1.5;
      
      if (!reachedMinimum) {
        return false;
      }
      
      return reachedTarget && hasProperEnding && notTruncated;
    }
    
    return hasProperEnding && notTruncated;
  };

  // 检测是否为YouTube链接
  const isYouTubeLink = (text: string): boolean => {
    const youtubePatterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
    ];
    return youtubePatterns.some(pattern => pattern.test(text));
  };

  // 提取YouTube视频ID
  const extractYouTubeVideoId = (url: string): string | null => {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    return null;
  };

  const handleAction = async () => {
    if (!apiKey || !inputText) return;
    
    setIsGenerating(true);
    setOutputText('');

    const nicheConfig = NICHES[niche];
    let localOutput = '';
    const MAX_CONTINUATIONS = 5; // 最大续写次数
    let continuationCount = 0;
    
    // 检测是否为YouTube链接
    const isYouTube = isYouTubeLink(inputText.trim());
    const videoId = isYouTube ? extractYouTubeVideoId(inputText.trim()) : null;
    
    // 如果只有 YouTube 链接，没有其他文本内容，直接提示用户
    if (isYouTube && videoId) {
      const textWithoutLink = inputText.trim().replace(/https?:\/\/(www\.)?(youtube\.com|youtu\.be)[^\s]*/gi, '').trim();
      
      // 如果移除链接后没有其他文本，说明只有链接
      if (!textWithoutLink || textWithoutLink.length < 10) {
        setIsGenerating(false);
        setOutputText(`📺 YouTube 視頻處理指南\n\n檢測到您輸入的是 YouTube 視頻鏈接：\n${inputText.trim()}\n\n---\n\n⚠️ **為什麼需要手動複製字幕？**\n\n由於瀏覽器安全限制（CORS 政策）和 YouTube 的 API 要求，前端應用無法直接訪問 YouTube 視頻的轉錄內容。要實現自動提取需要：\n\n• 後端服務器（處理 CORS 和 API 認證）\n• YouTube Data API v3 授權\n• OAuth 2.0 認證流程\n\n因此，目前最簡單可靠的方式是手動複製字幕。\n\n---\n\n📋 **操作步驟**\n\n1️⃣ **獲取視頻轉錄文本**\n   • 打開上述 YouTube 視頻\n   • 點擊視頻下方的「⋯」菜單\n   • 選擇「顯示轉錄」或「字幕」\n   • 複製完整的轉錄文本（可以全選複製）\n\n2️⃣ **粘貼轉錄文本**\n   • 將轉錄文本粘貼到「原始文本」輸入框\n   • 可以保留或刪除 YouTube 鏈接（系統會自動識別）\n   • 選擇處理模式（改寫/擴寫/摘要/潤色）\n\n3️⃣ **開始處理**\n   • 點擊生成按鈕\n   • 系統會根據您選擇的模式處理文本\n\n---\n\n💡 **小技巧**\n• 如果視頻有自動生成的字幕，通常質量也很好\n• 可以將鏈接和文本一起粘貼，系統會自動識別並處理文本\n• 複製時可以包含時間戳，系統會自動過濾\n\n🔮 **未來改進**\n如果後續添加後端服務支持，將可以實現一鍵自動提取功能。`);
        return;
      }
    }
    
    // Inject Niche Persona into the system instruction, enforce Chinese
    let systemInstruction = `${nicheConfig.systemInstruction}\n你也是一位專業的內容編輯。請務必使用繁體中文輸出。`;
    
    // 如果是YouTube链接（且有文本内容），添加特殊说明
    if (isYouTube && videoId) {
      systemInstruction += `\n\n⚠️ 重要提示：用戶提供了一個 YouTube 視頻鏈接（視頻ID: ${videoId}），同時也提供了轉錄文本。請直接處理轉錄文本內容，忽略鏈接部分。`;
    }
    
    const originalLength = inputText.length;

    // 生成初始prompt的函数
    const generateInitialPrompt = (mode: ToolMode, originalLength: number): string => {
        const inputSection = isYouTube && videoId 
            ? `## Input Data
⚠️ **檢測到 YouTube 視頻鏈接**（視頻ID: ${videoId}）

${inputText}

**注意**：上述輸入包含 YouTube 視頻鏈接和轉錄文本。請直接處理轉錄文本內容，忽略鏈接部分。`
            : `## Input Data
${inputText}`;

    switch (mode) {
        case ToolMode.REWRITE:
                return `### 任務指令：文本改寫與重構

${inputSection}

## 原文字數統計
原文共 ${originalLength} 字

## Goals
對上述文本進行深度改寫，使其在表達上與原文完全不同，但核心事實和觀點保持一致。

## Style Context
請以 ${nicheConfig.name} 的風格和語氣進行改寫，融入該領域的專業術語和表達方式。

## Constraints & Rules
1. **詞彙替換**：使用同義詞或更高級的詞彙替換原有詞彙，避免重複。
2. **句式變換**：將主動句改為被動句，長句拆短，短句合併，改變敘述語序。
3. **結構調整**：在不影響邏輯的前提下，調整段落或論點的順序。
4. **去AI味**：避免使用死板的翻譯腔，增加口語化或更自然的連接詞（如"其實"、"換句話說"、"說白了"）。
5. **完整性**：絕對不能丟失原文的關鍵數據、專有名詞和核心論點。
6. **賽道風格融合**：確保改寫後的文本符合 ${nicheConfig.name} 的獨特語氣和表達習慣。
7. **字數保持（重要）**：改寫後的文本字數必須 >= ${originalLength} 字，不得縮減內容。原文有5000字，改寫後也要保持5000字左右的篇幅。
8. **禁止提前收尾（關鍵）**：
   - ⚠️ **一次性輸出不可能完成全部內容，系統會自動續寫**
   - 在首次輸出時，**嚴禁使用任何收尾語**（如「下課」「散會」「下期再見」等）
   - 保持內容連貫流暢，自然過渡，不要有結束的意思
   - 只有在字數達標後的最終收尾時才使用收尾語
9. **TTS 純淨輸出（關鍵）**：
   - 嚴禁輸出任何括號內的描述詞，如「（教室的燈光漸漸暗去...）」「（院師猛地一拍驚堂木...）」
   - 嚴禁使用 **、*、__、~~ 等 Markdown 特殊符號
   - 嚴禁輸出章節標記、段落編號、說明文字、注釋或元信息
   - 只輸出純粹的第一人稱語音文稿內容，適合直接 TTS 配音

## Output Format
請直接輸出改寫後的純淨文本，保持簡潔連貫流暢，無需解釋或分析。嚴禁使用「## 」「### 」「1. 」「【】」「（）」「**」等任何標記。`;
        case ToolMode.EXPAND:
                const targetMinLength = Math.floor(originalLength * 1.5);
                const targetMaxLength = Math.floor(originalLength * 2);
                return `### 任務指令：深度內容擴寫

${inputSection}

## 原文字數統計
原文共 ${originalLength} 字
目標字數：${targetMinLength}-${targetMaxLength} 字（1.5-2倍擴寫）

## Goals
將提供的簡短文本或大綱擴展為一篇內容詳實、邏輯嚴密的深度文章，融入 ${nicheConfig.name} 的專業視角。

## Workflow
1. **分析核心觀點**：識別輸入文本中的主要論點和關鍵詞。
2. **多維展開**：
   - **What（是什麼）**：詳細解釋概念定義，使用 ${nicheConfig.name} 領域的專業術語。
   - **Why（為什麼）**：分析背後的原因、背景或動機，結合該領域的邏輯和思維方式。
   - **How（怎麼做）**：提供具體的方法論、步驟或解決方案。
   - **Example（舉例）**：根據上下文虛構或引用一個貼切的場景/案例來佐證觀點，案例要符合該領域特色。
3. **補充細節**：增加形容詞、描寫性語句和修辭手法，豐富文本的顆粒度。
4. **邏輯銜接**：使用過渡句，確保從一個點到另一個點的流動自然。
5. **風格融合**：全文保持 ${nicheConfig.name} 的獨特語氣和表達習慣。

## Constraints
- 擴寫後的字數必須達到 ${targetMinLength}-${targetMaxLength} 字（原文的1.5-2倍）。
- 保持原文的語氣（專業、幽默或嚴肅），並融入 ${nicheConfig.name} 的風格特色。
- 不要堆砌無意義的廢話，確保新增內容有實質信息量。
- **禁止提前收尾**：一次性輸出不可能完成全部內容，首次輸出時嚴禁使用「下課」「散會」等收尾語，保持內容連貫。
- **TTS 純淨輸出**：嚴禁輸出括號內的描述詞、**、*等特殊符號、章節標記、段落編號、說明文字或注釋。

## Output Format
直接輸出擴寫後的完整純淨文章，保持簡潔連貫流暢，無需分段標記或元信息。嚴禁使用「## 」「### 」「第一章」「（）」「**」等標記。`;
        case ToolMode.SUMMARIZE:
                return `### 任務指令：YouTube 內容摘要與優化

${inputSection}

## Goals
從 ${nicheConfig.name} 領域專家的視角，為上述文本生成完整的 YouTube 視頻內容包裝方案，包括標題、簡介、標籤和封面設計方案。

## Output Requirements（必須繁體中文輸出）

請按照以下格式輸出：

核心主題：
用一句話概括這篇文章在講什麼，要精準且吸引人。

YouTube 爆款標題（5個）：
1. [標題1 - 融入 ${nicheConfig.name} 的專業術語，40-60字]
2. [標題2 - 使用數字或疑問句增強吸引力]
3. [標題3 - 帶有情緒張力或懸念感]
4. [標題4 - 結合熱點或爭議性話題]
5. [標題5 - 直擊痛點或提供解決方案]

視頻簡介：
[開場鉤子1-2句話]

核心要點：
• [要點1]
• [要點2]
• [要點3]
• [要點4]
• [要點5]

[結尾CTA - 呼籲訂閱/評論/分享]

熱門標籤：
#標籤1 #標籤2 #標籤3 #標籤4 #標籤5 #標籤6 #標籤7 #標籤8 #標籤9 #標籤10

【標籤語言規則】
- ⚠️ 標籤語言必須與文案內容語言一致
- 如果文案是繁體中文，標籤必須全部使用繁體中文（如 #倪海廈 #中醫玄學 #風水）
- 如果文案是簡體中文，標籤必須全部使用簡體中文
- 如果文案是英文，標籤才使用英文
- 包含 ${nicheConfig.name} 領域專屬標籤和通用熱門標籤
- 禁止中英文混合標籤

封面設計方案：

AI 圖片提示詞（5個）：
1. [提示詞1 - 描述封面視覺元素，適合 Midjourney/Stable Diffusion，英文或中文]
2. [提示詞2 - 強調核心概念和情緒張力]
3. [提示詞3 - 突出關鍵人物或場景]
4. [提示詞4 - 展現衝突或對比]
5. [提示詞5 - 營造懸念或神秘感]

封面標題文案（5個，每個分上中下三行）：
1. 
   上行：[核心概念，不超過10字]
   中行：[關鍵信息，不超過10字]
   下行：[行動呼籲或懸念，不超過10字]

2. 
   上行：[核心概念，不超過10字]
   中行：[關鍵信息，不超過10字]
   下行：[行動呼籲或懸念，不超過10字]

3. 
   上行：[核心概念，不超過10字]
   中行：[關鍵信息，不超過10字]
   下行：[行動呼籲或懸念，不超過10字]

4. 
   上行：[核心概念，不超過10字]
   中行：[關鍵信息，不超過10字]
   下行：[行動呼籲或懸念，不超過10字]

5. 
   上行：[核心概念，不超過10字]
   中行：[關鍵信息，不超過10字]
   下行：[行動呼籲或懸念，不超過10字]

【封面設計要求】
- 圖片提示詞要具體描述視覺元素、色彩、構圖、風格
- 封面標題文案必須從內容核心提煉，每行不超過10個字
- 標題文案要簡潔有力，具有視覺衝擊力
- 上中下三行要有邏輯層次：上行吸引注意，中行傳達核心，下行引發行動

## Output Format
請嚴格按照上述格式輸出，使用繁體中文，無需額外解釋或分析。嚴禁使用 **、*、__、~~ 等 Markdown 特殊符號。`;
        case ToolMode.POLISH:
                return `### 任務指令：文本潤色與優化

${inputSection}

## 原文字數統計
原文共 ${originalLength} 字

## Goals
像一位嚴厲的文字編輯一樣，以 ${nicheConfig.name} 領域的專業標準優化這段文本，使其更具專業感、流暢感和高級感。

## Checkpoints
1. **語法修正**：糾正所有錯別字、標點錯誤和語病。
2. **詞彙升級**：將平庸的詞彙替換為更精準、更具表現力的詞彙（例如將"很多"改為"不勝枚舉"，將"好"改為"卓越"），並融入 ${nicheConfig.name} 領域的專業術語。
3. **修辭增強**：在合適的地方加入排比、比喻、反問等修辭手法，增強感染力和說服力。
4. **精簡冗餘**：刪除囉嗦的重複表達，使句子更乾練有力。
5. **語氣統一**：確保全文語氣一致（根據原文判斷是商務風、學術風還是文學風），並強化 ${nicheConfig.name} 的獨特風格。
6. **邏輯流暢**：優化句子之間的銜接，確保思路連貫、層次分明。
7. **字數保持**：潤色後的字數應與原文相當（約 ${originalLength} 字），不要大幅縮減或擴充。
8. **禁止提前收尾**：首次輸出時嚴禁使用「下課」「散會」等收尾語，保持內容連貫流暢。
9. **TTS 純淨輸出（關鍵）**：嚴禁輸出括號內的描述詞、**、*等特殊符號，只輸出純粹的第一人稱語音文稿。

## Comparison Standard
在"信（準確）、達（通順）、雅（優美）"三個維度上都必須有明顯提升，同時保持 ${nicheConfig.name} 的專業風範。

## Output Format
請直接輸出潤色後的純淨最終版本，保持簡潔連貫流暢，無需標註修改痕跡或解釋。嚴禁使用「## 」「### 」「修改說明：」「（）」「**」等任何標記。`;
            default:
                return '';
        }
    };

    // 生成续写prompt
    const generateContinuePrompt = (currentContent: string, mode: ToolMode, originalLength: number): string => {
        const context = currentContent.slice(-1000); // 取最后1000字作为上下文
        const currentLength = currentContent.length;
        
        if (mode === ToolMode.REWRITE || mode === ToolMode.POLISH) {
            const progress = (currentLength / originalLength * 100).toFixed(0);
            const needsMore = currentLength < originalLength * 0.9;
            
            return `繼續完成上述 ${nicheConfig.name} 風格的${mode === ToolMode.REWRITE ? '改寫' : '潤色'}，保持風格一致。

【已完成部分（末尾）】
${context}

【字數統計】
- 原文：${originalLength} 字
- 已完成：${currentLength} 字（${progress}%）
- ${needsMore ? `⚠️ 還需要約 ${originalLength - currentLength} 字` : '✓ 接近目標'}

【續寫規則（重要）】
${needsMore ? 
`⚠️ **字數嚴重不足，嚴禁使用任何收尾語！**
- 嚴禁使用「下課」「散會」「下期再見」「今天就到這」等收尾詞
- 直接自然銜接上文，繼續${mode === ToolMode.REWRITE ? '改寫' : '潤色'}
- 保持內容流暢連貫，不要有結束的意思` :
`✓ 字數已接近目標，可以適當收尾
- 在內容自然結束時，可以使用「下課」「下期再見」等收尾語
- 添加互動引導（如「歡迎在評論區分享你的看法」）`}
- **TTS 純淨輸出**：嚴禁輸出括號內的描述詞、**、*等特殊符號
- 第一行必須是「-----」，第二行開始直接續寫`;
        } else if (mode === ToolMode.EXPAND) {
            const targetMin = Math.floor(originalLength * 1.5);
            const progress = (currentLength / targetMin * 100).toFixed(0);
            const needsMore = currentLength < originalLength * 1.4;
            
            return `繼續完成上述 ${nicheConfig.name} 風格的深度擴寫，保持風格一致。

【已完成部分（末尾）】
${context}

【字數統計】
- 原文：${originalLength} 字，目標：${targetMin} 字
- 已擴寫：${currentLength} 字（${progress}%）
- ${needsMore ? `⚠️ 還需要約 ${targetMin - currentLength} 字` : '✓ 接近目標'}

【續寫規則（重要）】
${needsMore ?
`⚠️ **字數嚴重不足，嚴禁使用任何收尾語！**
- 直接自然銜接上文，繼續深入展開論述
- 保持內容流暢，不要有結束的意思` :
`✓ 字數已接近目標，可以適當收尾
- 確保內容完整、邏輯閉環
- 可以使用適當的收尾語和互動引導`}
- **TTS 純淨輸出**：嚴禁輸出括號內的描述詞、**、*等特殊符號
- 第一行必須是「-----」，第二行開始直接續寫`;
        }
        
        return '';
    };

    try {
        initializeGemini(apiKey, { provider });
        
        // 生成初始内容
        const initialPrompt = generateInitialPrompt(mode, originalLength);
        await streamContentGeneration(initialPrompt, systemInstruction, (chunk) => {
            localOutput += chunk;
            setOutputText(cleanMarkdownFormat(localOutput, mode));
        });
        
        // 检查是否需要续写（摘要模式不需要续写）
        if (mode !== ToolMode.SUMMARIZE) {
            while (!isContentComplete(localOutput, mode, originalLength) && continuationCount < MAX_CONTINUATIONS) {
                continuationCount++;
                console.log(`[Tools] Content incomplete, continuing (${continuationCount}/${MAX_CONTINUATIONS})...`);
                
                // 添加分隔符
                localOutput += '\n\n-----\n\n';
                setOutputText(cleanMarkdownFormat(localOutput, mode));
                
                // 生成续写prompt
                const continuePrompt = generateContinuePrompt(localOutput, mode, originalLength);
                
                // 续写
                await streamContentGeneration(continuePrompt, systemInstruction, (chunk) => {
                    localOutput += chunk;
                    setOutputText(cleanMarkdownFormat(localOutput, mode));
                });
            }
            
            if (isContentComplete(localOutput, mode, originalLength)) {
                console.log('[Tools] Content generation complete');
            } else {
                console.log('[Tools] Reached max continuations, stopping');
            }
        }
    } catch (e: any) {
        const errorMsg = e?.message || String(e) || '未知錯誤';
        console.error('[Tools] Error:', e);
        
        // 如果是 YouTube 链接且错误信息提示需要转录文本，显示友好提示
        if (isYouTube && (errorMsg.includes('網絡') || errorMsg.includes('API Key') || errorMsg.includes('連接'))) {
            setOutputText(`⚠️ YouTube 視頻處理提示\n\n檢測到您輸入的是 YouTube 視頻鏈接。\n\n由於系統無法直接訪問 YouTube 視頻內容，請按以下步驟操作：\n\n1. 打開 YouTube 視頻\n2. 點擊「⋯」菜單 → 選擇「顯示轉錄」或「字幕」\n3. 複製完整的轉錄文本\n4. 將轉錄文本粘貼到此處（可以保留或刪除 YouTube 鏈接）\n5. 再次點擊生成按鈕\n\n或者，如果您已經有轉錄文本，請將文本和鏈接一起粘貼，系統會自動處理文本內容。\n\n---\n\n錯誤詳情：${errorMsg}`);
        } else {
            // 显示详细的错误信息
            setOutputText(`❌ 生成內容時發生錯誤\n\n錯誤信息：${errorMsg}\n\n請檢查：\n1. API Key 是否正確配置\n2. 網絡連接是否正常\n3. API 服務是否可用\n\n如果問題持續，請聯繫技術支持。`);
        }
    } finally {
        setIsGenerating(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(outputText);
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
       {/* Settings Bar */}
       <div className="flex flex-col md:flex-row gap-4 justify-between items-center bg-slate-800/50 p-4 rounded-xl border border-slate-800">
           <div className="flex gap-2 overflow-x-auto pb-2 md:pb-0 w-full md:w-auto">
                {/* Tool Modes */}
                {[
                    { id: ToolMode.REWRITE, label: '改寫/洗稿', icon: <RefreshCw size={16} /> },
                    { id: ToolMode.EXPAND, label: '深度擴寫', icon: <Maximize2 size={16} /> },
                    { id: ToolMode.SUMMARIZE, label: '摘要總結', icon: <Scissors size={16} /> },
                    { id: ToolMode.POLISH, label: '潤色優化', icon: <FileText size={16} /> },
                ].map((tool) => (
                    <button
                        key={tool.id}
                        onClick={() => setMode(tool.id as ToolMode)}
                        className={`px-4 py-2 rounded-lg border flex items-center gap-2 transition-all whitespace-nowrap text-sm font-medium ${
                            mode === tool.id 
                            ? 'bg-indigo-600 text-white border-indigo-500 shadow-md' 
                            : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
                        }`}
                    >
                        {tool.icon}
                        <span>{tool.label}</span>
                    </button>
                ))}
           </div>

           <div className="flex items-center gap-4 w-full md:w-auto">
               {/* Niche Context Selector */}
               <div className="relative group min-w-[200px] flex-1 md:flex-none">
                   <label className="text-[10px] uppercase font-bold text-slate-500 mb-1 ml-1 tracking-wider">語氣 / 賽道</label>
                   <select 
                        value={niche} 
                        onChange={(e) => setNiche(e.target.value as NicheType)}
                        className="w-full appearance-none bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
                   >
                       {Object.values(NICHES).map(n => (
                           <option key={n.id} value={n.id}>{n.icon} {n.name}</option>
                       ))}
                   </select>
                   <ChevronDown className="absolute right-3 top-8 text-slate-500 pointer-events-none" size={14} />
               </div>

               {/* Generate Button */}
               <button 
                   onClick={handleAction}
                   disabled={isGenerating || !inputText}
                   className="flex items-center gap-2 px-4 md:px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg shadow-lg shadow-indigo-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:scale-105 active:scale-95 whitespace-nowrap"
               >
                   <ArrowRight size={18} />
                   <span className="hidden sm:inline">生成</span>
               </button>
           </div>
       </div>

      {/* Grid: Input and Output */}
       <div className="grid grid-cols-1 md:grid-cols-2 gap-6 h-[600px]">
            {/* Input */}
            <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-400 flex items-center gap-2">
            <span>原始文本</span>
            <span className="text-xs text-slate-600">（支持 YouTube 鏈接自動提取）</span>
          </label>
                <textarea 
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
            placeholder="請在此粘貼您的內容或 YouTube 鏈接..."
                    className="flex-1 bg-slate-800/50 border border-slate-700 rounded-xl p-4 text-slate-200 resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500 leading-relaxed custom-scrollbar"
                />
            </div>

            {/* Output */}
            <div className="flex flex-col gap-2 relative">
                <label className="text-sm font-medium text-slate-400 flex justify-between items-center">
                    <span>生成結果</span>
                    {outputText && (
                        <button onClick={copyToClipboard} className="text-xs flex items-center gap-1 text-indigo-400 hover:text-indigo-300">
                            <Copy size={12} /> 複製
                        </button>
                    )}
                </label>
                <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl p-4 text-slate-200 overflow-y-auto whitespace-pre-wrap leading-relaxed relative custom-scrollbar">
                    {outputText}
                    {isGenerating && (
                        <>
                            {!outputText && (
                                <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm">
                                    <div className="flex items-center gap-2">
                                        <span className="inline-block w-2 h-4 bg-indigo-500 animate-pulse" />
                                        <span>生成中...</span>
                                    </div>
                                </div>
                            )}
                            {outputText && <span className="inline-block w-2 h-4 bg-indigo-500 ml-1 animate-pulse" />}
                        </>
                    )}
                    {!outputText && !isGenerating && (
                        <div className="absolute inset-0 flex items-center justify-center text-slate-600 text-sm">
                            結果將顯示於此
                        </div>
                    )}
                </div>
            </div>
       </div>
    </div>
  );
};
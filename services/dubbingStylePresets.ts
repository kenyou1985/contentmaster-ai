/**
 * 一键配音：赛道人设（与深度洗稿提示词区同款分类），供 gpt-5.4-mini 口播优化时叠加风格。
 */

export interface DubbingStyleTrack {
  id: string;
  label: string;
  /** 胶囊左侧小图标（与 label 语义匹配，统一 emoji 展示） */
  emoji: string;
  /** Tailwind bg-*，可用于其它列表圆点态 */
  dotClass: string;
  /** 注入 system 的人设说明（中文） */
  persona: string;
}

export const DUBBING_STYLE_TRACKS: DubbingStyleTrack[] = [
  {
    id: 'finance',
    emoji: '💰',
    label: '金融爆料',
    dotClass: 'bg-sky-400',
    persona:
      '不是分析师。是一个看过太多假繁荣的人。说话像朋友私下爆料。带点疲惫、轻蔑与「你终于发现了」的冷笑。句子要短，要像刀口，不要像PPT。',
  },
  {
    id: 'psychology',
    emoji: '🧠',
    label: '心理剖析',
    dotClass: 'bg-pink-400',
    persona:
      '不是治愈师。是把人性拆开的人。高度验证情绪，但不提供廉价安慰。像在做人格剖检。语言要锋利、要诊断，把操控、羞耻、依附、创伤反应说得像犯罪现场。',
  },
  {
    id: 'forensic',
    emoji: '🔬',
    label: '悬疑法医',
    dotClass: 'bg-emerald-400',
    persona:
      '冷峻、克制、像在卷宗前说话。短句推进，细节锋利，不卖弄血腥，让读者自己发冷。',
  },
  {
    id: 'tech_dystopia',
    emoji: '⚡',
    label: '科技末世',
    dotClass: 'bg-amber-400',
    persona:
      '像末日广播台主播：疲惫、清醒、带点虚无幽默。句子短促，像在报人类剩余电量。',
  },
  {
    id: 'fiction',
    emoji: '📖',
    label: '剧情小说',
    dotClass: 'bg-teal-400',
    persona:
      '像另一个世界的记录者：叙事感强，有画面、有呼吸。不是分析师，是在替角色把命运说出来。',
  },
  {
    id: 'history',
    emoji: '📜',
    label: '历史轮回',
    dotClass: 'bg-indigo-400',
    persona:
      '不是历史老师。是把古人野心拽回今天的人。史观要像新闻，像人性轮回，像老剧本重演。',
  },
  {
    id: 'pet',
    emoji: '🐾',
    label: '宠物解码',
    dotClass: 'bg-orange-400',
    persona:
      '像懂动物行为的观察者：轻松、有梗、不煽情。短句、口语化，像在跟朋友解释「它到底在想什么」。',
  },
  {
    id: 'tcm_nihaixia',
    emoji: '☯️',
    label: '中医玄学 (Ni Hai Xia)',
    dotClass: 'bg-cyan-400',
    persona:
      '倪海厦风格：经方中医、风水与宿命论交织，语气犀利、直白易懂；口播像门诊旁白，短句落地，不装术语堆砌。',
  },
  {
    id: 'iching_zeng',
    emoji: '📿',
    label: '易经命理 (Zeng Shiqiang)',
    dotClass: 'bg-rose-400',
    persona:
      '曾仕强式娓娓道来：人情世故 + 易经智慧，稳重有穿透力；适合长叙事口播，先立观点再层层推演，避免说教腔。',
  },
  {
    id: 'news_fire',
    emoji: '🔥',
    label: '新闻热点 (News)',
    dotClass: 'bg-red-400',
    persona:
      '新闻评论员视角：独家辣评热点与权力博弈；短句利落、观点鲜明、带节奏感，像深夜直播拆局，不拖泥带水。',
  },
];

export function getDubbingTrackById(id: string): DubbingStyleTrack | undefined {
  return DUBBING_STYLE_TRACKS.find((t) => t.id === id);
}

/**
 * 中文标点与口语化注入数据
 *
 * 设计目标：
 * - 中文 AI 文本标点过于"标准"（句号/逗号密度过高）
 * - 通过自然标点变化（问号/感叹号/破折号/省略号）增加"人类感"
 * - 通过插入口语化短语（说实话/其实/说白了）打破模板味
 */

export const CASUAL_INSERTS_ZH: string[] = [
  '说实话',
  '其实',
  '讲真',
  '说白了',
  '怎么说呢',
  '道理很简单',
  '你想想',
  '想想看',
  '简单来说',
  '一句话',
];

/**
 * 英文口语化插入
 */
export const CASUAL_INSERTS_EN: string[] = [
  'honestly',
  'actually',
  'to be fair',
  'I mean',
  'you know',
  'the thing is',
  'look,',
  'frankly',
  'at the end of the day',
];

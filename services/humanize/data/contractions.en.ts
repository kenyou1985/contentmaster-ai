/**
 * 英文缩写扩展/收缩表
 * - 用于 postprocess 阶段给文本注入缩写（增加"自然"信号）
 * - 或将缩写扩展为完整形式（用于正式文档）
 */

export const CONTRACTIONS_EN: Array<[string, string]> = [
  ["don't", 'do not'],
  ['dont', 'do not'],
  ["can't", 'cannot'],
  ['cant', 'cannot'],
  ["won't", 'will not'],
  ['wont', 'will not'],
  ["isn't", 'is not'],
  ['isnt', 'is not'],
  ["aren't", 'are not'],
  ['arent', 'are not'],
  ["wasn't", 'was not'],
  ['wasnt', 'was not'],
  ["weren't", 'were not'],
  ['werent', 'were not'],
  ["hasn't", 'has not'],
  ['hasnt', 'has not'],
  ["haven't", 'have not'],
  ['havent', 'have not'],
  ["hadn't", 'had not'],
  ['hadnt', 'had not'],
  ["doesn't", 'does not'],
  ['doesnt', 'does not'],
  ["didn't", 'did not'],
  ['didnt', 'did not'],
  ["shouldn't", 'should not'],
  ['shouldnt', 'should not'],
  ["wouldn't", 'would not'],
  ['wouldnt', 'would not'],
  ["couldn't", 'could not'],
  ['couldnt', 'could not'],
  ["I'm", 'I am'],
  ["you're", 'you are'],
  ["he's", 'he is'],
  ["she's", 'she is'],
  ["it's", 'it is'],
  ["we're", 'we are'],
  ["they're", 'they are'],
  ["I've", 'I have'],
  ["you've", 'you have'],
  ["we've", 'we have'],
  ["they've", 'they have'],
  ["I'll", 'I will'],
  ["you'll", 'you will'],
  ["he'll", 'he will'],
  ["she'll", 'she will'],
  ["we'll", 'we will'],
  ["they'll", 'they will'],
  ["I'd", 'I would'],
  ["you'd", 'you would'],
  ["he'd", 'he would'],
  ["she'd", 'she would'],
  ["we'd", 'we would'],
  ["they'd", 'they would'],
  ["let's", 'let us'],
  ["that's", 'that is'],
  ["there's", 'there is'],
  ["here's", 'here is'],
  ["what's", 'what is'],
  ["who's", 'who is'],
];

/** 注入缩写时优先使用（更适合自然口语） */
export const CONTRACTIONS_EN_PREFERRED: string[] = [
  "don't",
  "won't",
  "isn't",
  "it's",
  "we're",
  "they're",
  "I'm",
  "you're",
];

/** 反向：从扩展形式还原为缩写 */
export const EXPANSIONS_EN_TO_CONTRACTION = new Map<string, string>(
  CONTRACTIONS_EN.map(([short, expanded]) => [expanded.toLowerCase(), short]),
);

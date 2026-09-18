/**
 * 封面模块（v11.1）
 *
 * 独立"封面"模块入口（底部导航栏的"封面"菜单）
 * - 直接复用 CopyBasedPanel 的「输入文案 + 生成 7 种封面方案」功能
 * - 通过 variant='cover-only' 隐藏配音 / MP4 导出部分
 * - UI 显示和逻辑代码完全复用 CopyBasedPanel，避免代码重复
 *
 * 使用方法：
 *   <CoverPanel apiKey={apiKey} runningHubApiKey={runningHubApiKey} />
 */

import React from 'react';
import CopyBasedPanel from './CopyBasedPanel';

interface CoverPanelProps {
  apiKey: string;
  runningHubApiKey: string;
}

export const CoverPanel: React.FC<CoverPanelProps> = ({ apiKey, runningHubApiKey }) => {
  return <CopyBasedPanel variant="cover-only" apiKey={apiKey} runningHubApiKey={runningHubApiKey} />;
};

export default CoverPanel;

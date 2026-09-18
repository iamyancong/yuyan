/**
 * 受控单次远程命令执行 Hook (P2)
 * @description 管理底部非交互式命令执行面板、常用预设填入及输出回显
 */

import { ref } from 'vue';
import message from 'ant-design-vue/es/message';
import { execServerCommand, type DeployServer, type RemoteExecResult } from '@/api/deploy';
import type { PresetCommandChip } from '../constant';

export function useRemoteExec(props: { server?: DeployServer | null }) {
  const execPanelVisible = ref(false);
  const commandText = ref('');
  const executing = ref(false);
  const execResult = ref<RemoteExecResult | null>(null);

  /**
   * 切换命令面板显隐
   */
  const toggleExecPanel = () => {
    execPanelVisible.value = !execPanelVisible.value;
  };

  /**
   * 应用预设命令
   * @param chip 预设芯片
   */
  const applyPreset = (chip: PresetCommandChip) => {
    commandText.value = chip.command;
  };

  /**
   * 执行当前命令
   * @param cwd 当前目录作为执行工作区
   */
  const runCommand = async (cwd?: string) => {
    const serverId = props.server?.id;
    if (!serverId) return;

    const cmd = commandText.value.trim();
    if (!cmd) {
      message.warning('请输入要执行的命令');
      return;
    }

    executing.value = true;
    try {
      const res = await execServerCommand(serverId, cmd, cwd);
      execResult.value = res;
      if (res.code === 0) {
        message.success(`命令执行成功 (${res.durationMs}ms)`);
      } else {
        message.warning(`命令执行完毕，返回状态码 ${res.code}`);
      }
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '执行命令失败');
    } finally {
      executing.value = false;
    }
  };

  return {
    execPanelVisible,
    commandText,
    executing,
    execResult,
    toggleExecPanel,
    applyPreset,
    runCommand,
  };
}

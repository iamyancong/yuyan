<script setup lang="ts">
import {
  SettingOutlined,
  DashboardOutlined,
  SafetyOutlined,
  SaveOutlined,
  ReloadOutlined,
} from '@ant-design/icons-vue';
import { useVpnSettings } from './hooks/useVpnSettings';

defineOptions({ name: 'VpnSettings' });

const {
  formState,
  loading,
  saving,
  saveConfig,
  loadConfig,
} = useVpnSettings();
</script>

<template>
  <div class="settings-container">
    <div class="settings-header" data-tauri-drag-region>
      <h1>分流与连接配置</h1>
    </div>

    <a-spin :spinning="loading">
      <!-- 1. Fortinet 配置块 -->
      <div class="settings-glass-card">
        <div class="section-title">
          <DashboardOutlined />
          Fortinet VPN 配置
        </div>
        
        <a-form layout="vertical">
          <a-row :gutter="24">
            <a-col :span="12">
              <a-form-item label="网关主机 Host">
                <a-input v-model:value="formState.fortinetHost" placeholder="例如: 219.141.235.68" />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item label="网关端口 Port">
                <a-input-number v-model:value="formState.fortinetPort" style="width: 100%" placeholder="12345" />
              </a-form-item>
            </a-col>
          </a-row>

          <a-row :gutter="24">
            <a-col :span="12">
              <a-form-item label="登录账号 Username">
                <a-input v-model:value="formState.fortinetUsername" placeholder="ssl" />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item label="登录密码 Password">
                <a-input-password v-model:value="formState.fortinetPassword" placeholder="请输入 VPN 登录密码" />
              </a-form-item>
            </a-col>
          </a-row>

          <a-row :gutter="24">
            <a-col :span="24">
              <a-form-item label="自定义分流路由网段 (逗号分隔多个)">
                <a-input v-model:value="formState.fortinetRoutes" placeholder="如 192.168.100.0/24, 10.0.0.0/8" />
              </a-form-item>
            </a-col>
          </a-row>
        </a-form>
      </div>

      <!-- 2. aTrust 配置块 -->
      <div class="settings-glass-card">
        <div class="section-title">
          <SafetyOutlined />
          aTrust VPN 配置
        </div>

        <a-form layout="vertical">
          <a-row :gutter="24">
            <a-col :span="12">
              <a-form-item label="网关主机 Host (已固定默认)">
                <a-input v-model:value="formState.atrustHost" disabled placeholder="222.240.48.26" />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item label="网关端口 Port (已固定默认)">
                <a-input-number v-model:value="formState.atrustPort" disabled style="width: 100%" placeholder="60201" />
              </a-form-item>
            </a-col>
          </a-row>

          <a-row :gutter="24">
            <a-col :span="12">
              <a-form-item label="登录账号 Username (已固定默认)">
                <a-input v-model:value="formState.atrustUsername" disabled placeholder="yssdm" />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item label="登录密码 Password">
                <a-input-password v-model:value="formState.atrustPassword" placeholder="请输入 aTrust 登录密码" />
              </a-form-item>
            </a-col>
          </a-row>

          <a-row :gutter="24">
            <a-col :span="24">
              <a-form-item label="自定义分流路由网段 (可选，留空走服务端默认下发网段)">
                <a-input v-model:value="formState.atrustRoutes" placeholder="高校下发网段无需配置，如有其它网段需要强制指定可在此填写" />
              </a-form-item>
            </a-col>
          </a-row>
        </a-form>
      </div>

      <!-- 保存操作栏 -->
      <div class="settings-footer">
        <a-button @click="loadConfig">
          <template #icon><ReloadOutlined /></template>
          放弃更改
        </a-button>
        <a-button type="primary" :loading="saving" @click="saveConfig">
          <template #icon><SaveOutlined /></template>
          保存配置
        </a-button>
      </div>
    </a-spin>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>

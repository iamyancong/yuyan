/**
 * 后端工程模板与预设定义
 * @description 提供通用 Spring Boot、Maven 多模块与赢时胜专属架构的配置画像
 */

/** 后端模板 Key */
export type BackendTemplateKey =
  | 'spring-boot-single-jar'
  | 'maven-multi-module-starter'
  | 'yss-valuation-outsourced'
  | 'custom';

/** 后端工程模板定义接口 */
export interface BackendProjectTemplate {
  /** 模板唯一标识 */
  key: BackendTemplateKey;
  /** 模板展示名称 */
  label: string;
  /** 模板简短描述 */
  description: string;
  /** 默认构建命令 */
  buildCommand: string;
  /** 默认产物相对目录/路径 */
  artifactDir: string;
  /** 默认产物匹配规则 */
  artifactPattern: string;
  /** 默认 OpenAPI 生成命令 */
  openapiCommand: string;
  /** 默认 OpenAPI 输出相对路径 */
  openapiOutputPath: string;
  /** 默认服务端口 */
  serverPort: number;
  /** 默认健康检查路径 */
  healthCheckPath: string;
}

/** 内置后端项目模板配置列表 */
export const BACKEND_TEMPLATES: Record<BackendTemplateKey, BackendProjectTemplate> = {
  'spring-boot-single-jar': {
    key: 'spring-boot-single-jar',
    label: 'Spring Boot 单模块 (Single Jar)',
    description: '根目录单模块工程，直接打包生成单个 Jar',
    buildCommand: './mvnw -nsu clean package -DskipTests',
    artifactDir: 'target/*.jar',
    artifactPattern: 'target/*.jar',
    openapiCommand: './mvnw -nsu smart-doc:openapi',
    openapiOutputPath: 'target/openapi/openapi.json',
    serverPort: 8080,
    healthCheckPath: '/actuator/health',
  },
  'maven-multi-module-starter': {
    key: 'maven-multi-module-starter',
    label: 'Maven 多模块微服务 (Multi-Module)',
    description: '标准多模块工程，构建指定 starter 或 web 模块',
    buildCommand: './mvnw -nsu clean package -pl {starterModule} -am -DskipTests',
    artifactDir: '{starterModule}/target/*.jar',
    artifactPattern: '{starterModule}/target/*.jar',
    openapiCommand: './mvnw -nsu -f {starterModule}/pom.xml smart-doc:openapi',
    openapiOutputPath: '{starterModule}/target/openapi/openapi.json',
    serverPort: 8080,
    healthCheckPath: '/actuator/health',
  },
  'yss-valuation-outsourced': {
    key: 'yss-valuation-outsourced',
    label: '赢时胜外包微服务预设 (Valuation Outsourced)',
    description: '估值外包专属多模块架构，打包 valuation-outsourced-starter',
    buildCommand: './mvnw -nsu clean package -pl valuation-outsourced-starter -am -DskipTests',
    artifactDir: 'valuation-outsourced-starter/target/valuation-outsourced-starter-*.jar',
    artifactPattern: 'valuation-outsourced-starter/target/valuation-outsourced-starter-*.jar',
    openapiCommand: './mvnw -nsu -f valuation-outsourced-starter/pom.xml smart-doc:openapi',
    openapiOutputPath: 'valuation-outsourced-starter/target/openapi/openapi.json',
    serverPort: 9999,
    healthCheckPath: '/monitor/health',
  },
  custom: {
    key: 'custom',
    label: '自定义配置 (Custom)',
    description: '自由配置构建命令与 Jar 产物路径',
    buildCommand: '',
    artifactDir: '',
    artifactPattern: '',
    openapiCommand: '',
    openapiOutputPath: '',
    serverPort: 8080,
    healthCheckPath: '/actuator/health',
  },
};

/** 供 Formily / Select 组件使用的模板选项列表 */
export const BACKEND_TEMPLATE_OPTIONS: Array<{ label: string; value: BackendTemplateKey; description: string }> = [
  {
    label: BACKEND_TEMPLATES['spring-boot-single-jar'].label,
    value: 'spring-boot-single-jar',
    description: BACKEND_TEMPLATES['spring-boot-single-jar'].description,
  },
  {
    label: BACKEND_TEMPLATES['maven-multi-module-starter'].label,
    value: 'maven-multi-module-starter',
    description: BACKEND_TEMPLATES['maven-multi-module-starter'].description,
  },
  {
    label: BACKEND_TEMPLATES['yss-valuation-outsourced'].label,
    value: 'yss-valuation-outsourced',
    description: BACKEND_TEMPLATES['yss-valuation-outsourced'].description,
  },
  {
    label: BACKEND_TEMPLATES.custom.label,
    value: 'custom',
    description: BACKEND_TEMPLATES.custom.description,
  },
];

/**
 * 根据项目名称推导默认多模块 starter 模块名称
 * @param projectName 项目名称
 * @returns 模块名称
 */
export function deriveStarterModuleName(projectName?: string): string {
  const normalized = String(projectName || '').trim();
  if (!normalized) return 'app-starter';
  if (normalized.endsWith('-starter') || normalized.endsWith('-service') || normalized.endsWith('-server')) {
    return normalized;
  }
  return `${normalized}-starter`;
}

/**
 * 动态解析模板的具体配置值（替换占位符）
 * @param templateKey 模板标识
 * @param projectName 项目名称
 * @returns 解析后的具体参数对象
 */
export function resolveBackendTemplateValues(
  templateKey: BackendTemplateKey,
  projectName?: string
): Omit<BackendProjectTemplate, 'key' | 'label' | 'description'> {
  const template = BACKEND_TEMPLATES[templateKey] || BACKEND_TEMPLATES['spring-boot-single-jar'];
  if (templateKey === 'custom') {
    return {
      buildCommand: '',
      artifactDir: '',
      artifactPattern: '',
      openapiCommand: '',
      openapiOutputPath: '',
      serverPort: 8080,
      healthCheckPath: '/actuator/health',
    };
  }

  const moduleName = deriveStarterModuleName(projectName);
  const replaceModule = (text: string) => text.replace(/\{starterModule\}/g, moduleName);

  return {
    buildCommand: replaceModule(template.buildCommand),
    artifactDir: replaceModule(template.artifactDir),
    artifactPattern: replaceModule(template.artifactPattern),
    openapiCommand: replaceModule(template.openapiCommand),
    openapiOutputPath: replaceModule(template.openapiOutputPath),
    serverPort: template.serverPort,
    healthCheckPath: template.healthCheckPath,
  };
}

/**
 * 根据项目名称智能推荐初始模板
 * @param projectName 项目名称
 * @returns 推荐的模板 Key
 */
export function recommendTemplateForProject(projectName?: string): BackendTemplateKey {
  const name = String(projectName || '').toLowerCase();
  if (name.includes('valuation-outsourced')) {
    return 'yss-valuation-outsourced';
  }
  return 'spring-boot-single-jar';
}

/**
 * 根据现有目标配置反向推导对应的模板 Key
 * @param config 配置对象
 * @returns 推导出的模板标识
 */
export function detectBackendTemplateKey(config: {
  buildCommand?: string;
  artifactDir?: string;
  artifactPattern?: string;
}): BackendTemplateKey {
  const buildCmd = String(config.buildCommand || '').trim();
  const artifact = String(config.artifactPattern || config.artifactDir || '').trim();

  if (!buildCmd && !artifact) {
    return 'spring-boot-single-jar';
  }

  if (buildCmd.includes('valuation-outsourced') || artifact.includes('valuation-outsourced')) {
    return 'yss-valuation-outsourced';
  }

  if (
    buildCmd.includes('-pl') ||
    (/\/[^/]*target\//.test(artifact) && (buildCmd.includes('mvn') || !buildCmd))
  ) {
    return 'maven-multi-module-starter';
  }

  if (
    artifact.startsWith('target/') ||
    (buildCmd.includes('clean package') && !buildCmd.includes('-pl'))
  ) {
    return 'spring-boot-single-jar';
  }

  return 'custom';
}

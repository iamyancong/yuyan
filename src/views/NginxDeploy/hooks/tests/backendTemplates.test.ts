import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BACKEND_TEMPLATES,
  deriveStarterModuleName,
  detectBackendTemplateKey,
  recommendTemplateForProject,
  resolveBackendTemplateValues,
} from '../../templates/backendTemplates.ts';

test('智能推荐模板：估值外包命中专属预设，通用项目推荐单模块', () => {
  assert.equal(recommendTemplateForProject('yss-valuation-outsourced'), 'yss-valuation-outsourced');
  assert.equal(recommendTemplateForProject('valuation-outsourced-web'), 'yss-valuation-outsourced');
  assert.equal(recommendTemplateForProject('trade-order-service'), 'spring-boot-single-jar');
  assert.equal(recommendTemplateForProject('user-center'), 'spring-boot-single-jar');
  assert.equal(recommendTemplateForProject(''), 'spring-boot-single-jar');
});

test('多模块 starter 模块名称智能推导', () => {
  assert.equal(deriveStarterModuleName('trade-service'), 'trade-service');
  assert.equal(deriveStarterModuleName('payment-starter'), 'payment-starter');
  assert.equal(deriveStarterModuleName('auth-server'), 'auth-server');
  assert.equal(deriveStarterModuleName('order'), 'order-starter');
  assert.equal(deriveStarterModuleName(''), 'app-starter');
});

test('解析模板配置：Spring Boot 单模块输出通用命令', () => {
  const values = resolveBackendTemplateValues('spring-boot-single-jar', 'trade-service');
  assert.equal(values.buildCommand, './mvnw -nsu clean package -DskipTests');
  assert.equal(values.artifactDir, 'target/*.jar');
  assert.equal(values.artifactPattern, 'target/*.jar');
  assert.equal(values.serverPort, 8080);
  assert.equal(values.healthCheckPath, '/actuator/health');
  assert.equal(values.openapiCommand, './mvnw -nsu smart-doc:openapi');
});

test('解析模板配置：Maven 多模块根据项目名称动态替换 starterModule 占位符', () => {
  const values = resolveBackendTemplateValues('maven-multi-module-starter', 'order-center');
  assert.equal(values.buildCommand, './mvnw -nsu clean package -pl order-center-starter -am -DskipTests');
  assert.equal(values.artifactDir, 'order-center-starter/target/*.jar');
  assert.equal(values.artifactPattern, 'order-center-starter/target/*.jar');
  assert.equal(values.openapiCommand, './mvnw -nsu -f order-center-starter/pom.xml smart-doc:openapi');
  assert.equal(values.openapiOutputPath, 'order-center-starter/target/openapi/openapi.json');
});

test('解析模板配置：赢时胜外包专属预设完整保留原有配置', () => {
  const values = resolveBackendTemplateValues('yss-valuation-outsourced', 'any-name');
  assert.equal(values.buildCommand, './mvnw -nsu clean package -pl valuation-outsourced-starter -am -DskipTests');
  assert.equal(values.artifactDir, 'valuation-outsourced-starter/target/valuation-outsourced-starter-*.jar');
  assert.equal(values.serverPort, 9999);
  assert.equal(values.healthCheckPath, '/monitor/health');
});

test('反向检测：根据构建命令和产物路径识别对应的模板 Key', () => {
  assert.equal(
    detectBackendTemplateKey({
      buildCommand: './mvnw -nsu clean package -pl valuation-outsourced-starter -am -DskipTests',
    }),
    'yss-valuation-outsourced'
  );

  assert.equal(
    detectBackendTemplateKey({
      buildCommand: './mvnw -nsu clean package -pl order-starter -am -DskipTests',
      artifactDir: 'order-starter/target/*.jar',
    }),
    'maven-multi-module-starter'
  );

  assert.equal(
    detectBackendTemplateKey({
      buildCommand: './mvnw -nsu clean package -DskipTests',
      artifactDir: 'target/*.jar',
    }),
    'spring-boot-single-jar'
  );

  assert.equal(
    detectBackendTemplateKey({
      buildCommand: 'gradle build',
      artifactDir: 'build/libs/*.jar',
    }),
    'custom'
  );
});

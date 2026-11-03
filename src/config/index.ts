/** Public module boundary. Consumers receive contract interfaces. */

export { ConfigError } from '../config-error.js';
import {
  parseConfigDocument as parseConfigDocumentImplementation,
  parseConfigFileText as parseConfigFileTextImplementation,
  resolveConfigFilePath as resolveConfigFilePathImplementation,
  loadConfigFile as loadConfigFileImplementation,
} from '../config-file.js';
export const parseConfigDocument: import('@qqbot/contracts').parseConfigDocument =
  parseConfigDocumentImplementation;
export const parseConfigFileText: import('@qqbot/contracts').parseConfigFileText =
  parseConfigFileTextImplementation;
export const resolveConfigFilePath: import('@qqbot/contracts').resolveConfigFilePath =
  resolveConfigFilePathImplementation;
export const loadConfigFile: import('@qqbot/contracts').loadConfigFile =
  loadConfigFileImplementation;
export { DEFAULT_CONFIG_FILE } from '../config-file.js';
import {
  parseIncludeDirectives as parseIncludeDirectivesImplementation,
  resolveIncludePath as resolveIncludePathImplementation,
  deepMergeConfig as deepMergeConfigImplementation,
  loadConfigGraph as loadConfigGraphImplementation,
} from '../config-includes.js';
export const parseIncludeDirectives: import('@qqbot/contracts').parseIncludeDirectives =
  parseIncludeDirectivesImplementation;
export const resolveIncludePath: import('@qqbot/contracts').resolveIncludePath =
  resolveIncludePathImplementation;
export const deepMergeConfig: import('@qqbot/contracts').deepMergeConfig =
  deepMergeConfigImplementation;
export const loadConfigGraph: import('@qqbot/contracts').loadConfigGraph =
  loadConfigGraphImplementation;
import {
  loadConfig as loadConfigImplementation,
  resolveLoggingSettings as resolveLoggingSettingsImplementation,
  describeConfig as describeConfigImplementation,
} from '../config.js';
export const loadConfig: import('@qqbot/contracts').loadConfig = loadConfigImplementation;
export const resolveLoggingSettings: import('@qqbot/contracts').resolveLoggingSettings =
  resolveLoggingSettingsImplementation;
export const describeConfig: import('@qqbot/contracts').describeConfig =
  describeConfigImplementation;
export { DEFAULT_OFFPEAK_WINDOWS } from '../config.js';
import {
  parseModelApiSection as parseModelApiSectionImplementation,
  assertModelApiConfig as assertModelApiConfigImplementation,
  resolveAuxRoute as resolveAuxRouteImplementation,
  renderModelApiPatch as renderModelApiPatchImplementation,
  writeModelApiPatch as writeModelApiPatchImplementation,
} from '../dsh/model-config.js';
export const parseModelApiSection: import('@qqbot/contracts').parseModelApiSection =
  parseModelApiSectionImplementation;
export const assertModelApiConfig: import('@qqbot/contracts').assertModelApiConfig =
  assertModelApiConfigImplementation;
export const resolveAuxRoute: import('@qqbot/contracts').resolveAuxRoute =
  resolveAuxRouteImplementation;
export const renderModelApiPatch: import('@qqbot/contracts').renderModelApiPatch =
  renderModelApiPatchImplementation;
export const writeModelApiPatch: import('@qqbot/contracts').writeModelApiPatch =
  writeModelApiPatchImplementation;
export { DEEPSEEK_OFFICIAL_PROVIDER, MODEL_API_PATCH_FILENAME } from '../dsh/model-config.js';

"use strict";

/**
 * 与 Qoder CN 本机数据布局耦合的路径常量。
 *
 * 这是方案 §3.1(4) 要求的"窄适配层"的一部分：所有与宿主路径/格式耦合的常量集中于此，
 * 宿主版本漂移（尤其是版本化安装目录 `.qoder-versions\<ver>` 与配置文件名变化）时只改这一个文件。
 *
 * 常量来源：对 Qoder CN 本机数据布局的只读勘查（见设计文档 §2.2），非推测。
 * 注意：本模块刻意不依赖宿主安装目录 —— 上面几个路径都在用户数据/配置层，不含版本号。
 */

const os = require("node:os");
const path = require("node:path");

/** Qoder CN 的配置与工程数据根目录。 */
const QODER_HOME = path.join(os.homedir(), ".qoder-cn");

/** 启用插件清单与第三方模型 provider 配置。**此文件包含明文 API Key，属凭证文件。** */
const SETTINGS_PATH = path.join(QODER_HOME, "settings.json");

/** 宿主主进程写入的登录态/昵称/头像/版本快照。 */
const APP_STATUS_PATH = path.join(QODER_HOME, ".qoder-app-status.json");

module.exports = {
  QODER_HOME,
  SETTINGS_PATH,
  APP_STATUS_PATH
};

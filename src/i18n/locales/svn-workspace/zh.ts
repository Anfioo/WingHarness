import common from "./common/zh.json";
import welcome from "./welcome/zh.json";
import changes from "./changes/zh.json";
import commit from "./commit/zh.json";
import update from "./update/zh.json";
import checkout from "./checkout/zh.json";
import log from "./log/zh.json";
import diff from "./diff/zh.json";
import blame from "./blame/zh.json";
import stash from "./stash/zh.json";
import settings from "./settings/zh.json";

/**
 * The SVN workspace's Chinese strings, one fragment per domain. Each fragment
 * is owned by the phase that builds that domain; the aggregator is frozen here
 * so two phases never edit the same file.
 */
export default {
  common,
  welcome,
  changes,
  commit,
  update,
  checkout,
  log,
  diff,
  blame,
  stash,
  settings,
};

import common from "./common/en.json";
import welcome from "./welcome/en.json";
import changes from "./changes/en.json";
import commit from "./commit/en.json";
import update from "./update/en.json";
import checkout from "./checkout/en.json";
import log from "./log/en.json";
import diff from "./diff/en.json";
import blame from "./blame/en.json";
import stash from "./stash/en.json";
import settings from "./settings/en.json";

/**
 * The SVN workspace's English strings, one fragment per domain. Each fragment
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

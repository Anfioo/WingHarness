import common from "./common/en.json";
import welcome from "./welcome/en.json";
import collection from "./collection/en.json";
import request from "./request/en.json";
import response from "./response/en.json";
import environment from "./environment/en.json";
import importSpec from "./import/en.json";

/**
 * The API client's English strings, one fragment per domain. Adding a domain
 * means adding the fragment here and in `zh.ts`; nothing else reads these files.
 */
export default {
  common,
  welcome,
  collection,
  request,
  response,
  environment,
  import: importSpec,
};

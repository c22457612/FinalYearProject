// public/app/core.js
import * as api from "./api.js";
import * as utils from "./utils.js";

window.VPT = window.VPT || {};
window.VPT.api = api;
window.VPT.utils = utils;

//a quick debug flag you can check in console
window.VPT.__ready = true;

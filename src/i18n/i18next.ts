import { moment } from "obsidian";

/** ---- IMPORT TRANSLATIONS ---- */
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fi from "./locales/fi.json";
import fr from "./locales/fr.json";
import ko from "./locales/ko.json";
import ru from "./locales/ru.json";
import tr from "./locales/tr.json";
import zhCN from "./zh-CN-personal.json";
import zhTW from "./locales/zh-TW.json";
/** ---- IMPORT TRANSLATIONS ---- */

/** ---- RESOURCE OBJECT ---- */
export const resources = {
	de: {
		translation: de,
	},
	en: {
		translation: en,
	},
	es: {
		translation: es,
	},
	fi: {
		translation: fi,
	},
	fr: {
		translation: fr,
	},
	ko: {
		translation: ko,
	},
	ru: {
		translation: ru,
	},
	tr: {
		translation: tr,
	},
	zhCN: {
		translation: zhCN,
	},
	zhTW: {
		translation: zhTW,
	},
} as const;
/** ---- RESOURCE OBJECT ---- */
const localeUsed: string = window.localStorage.language || moment.locale();
const normalized = localeUsed.trim().replace(/[-_]/g, "").toLowerCase();
const aliases: Record<string, string> = { zh: "zhcn", zhhans: "zhcn", zhhanscn: "zhcn", zhhant: "zhtw", zhhanttw: "zhtw" };
export const translationLanguage = Object.keys(resources).find(key => key.toLowerCase() === (aliases[normalized] || normalized)) || "en";

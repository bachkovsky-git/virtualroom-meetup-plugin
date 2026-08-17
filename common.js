(function (root) {
  "use strict";

  function normalizeName(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase("ru-RU")
      .replace(/ё/g, "е");
  }

  // Word order is ignored so that "Иван Иванов" also matches
  // "Иванов Иван" on the page.
  function comparisonKey(value) {
    return normalizeName(value)
      .split(" ")
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "ru"))
      .join(" ");
  }

  function parseExpected(value) {
    const unique = new Map();

    String(value || "")
      .split(/[\r\n;]+/)
      .map((name) => name.replace(/^\s*[-•]\s*/, "").trim())
      .filter(Boolean)
      .forEach((name) => {
        const key = comparisonKey(name);
        if (key && !unique.has(key)) {
          unique.set(key, name);
        }
      });

    return Array.from(unique.values());
  }

  function initials(value) {
    return normalizeName(value)
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toLocaleUpperCase("ru-RU"))
      .join("");
  }

  function roomKey(value) {
    try {
      const url = new URL(value);
      url.hash = "";
      return url.toString();
    } catch (_error) {
      return String(value || "").split("#")[0];
    }
  }

  function rosterById(rosters, id) {
    return (rosters || []).find((roster) => roster.id === id) || null;
  }

  function rosterForRoom(state, key) {
    const assignedId = state.roomAssignments?.[key];
    return rosterById(state.rosters, assignedId) ||
      rosterById(state.rosters, state.selectedRosterId) ||
      state.rosters?.[0] ||
      null;
  }

  function participantMatchKeys(roster, participantName) {
    const expectedKey = comparisonKey(participantName);
    const aliasKeys = (roster?.aliases?.[expectedKey] || []).map(comparisonKey);
    return Array.from(new Set([expectedKey, ...aliasKeys].filter(Boolean)));
  }

  function rosterMatchKeys(roster) {
    return new Set(
      (roster?.participants || []).flatMap((name) => participantMatchKeys(roster, name))
    );
  }

  function nameTokens(value) {
    return comparisonKey(value).split(" ").filter(Boolean);
  }

  // Отчество бывает указано только в одном из источников: в комнате человек
  // подписан «Трегубов Максим Сергеевич», а в списке — «Трегубов Максим».
  // Считаем это одним человеком, если все слова короткого имени входят
  // в длинное. Одного слова для такого вывода мало.
  function namesMatch(first, second) {
    const firstTokens = nameTokens(first);
    const secondTokens = nameTokens(second);
    if (!firstTokens.length || !secondTokens.length) return false;
    if (firstTokens.join(" ") === secondTokens.join(" ")) return true;

    const [shorter, longer] = firstTokens.length <= secondTokens.length
      ? [firstTokens, secondTokens]
      : [secondTokens, firstTokens];
    if (shorter.length < 2) return false;
    return shorter.every((token) => longer.includes(token));
  }

  function participantIsPresent(roster, participantName, actualNameKeys) {
    const actualKeys = actualNameKeys instanceof Set
      ? actualNameKeys
      : new Set(Array.from(actualNameKeys || [], comparisonKey));
    const matchKeys = participantMatchKeys(roster, participantName);
    if (matchKeys.some((key) => actualKeys.has(key))) return true;
    return matchKeys.some((key) =>
      Array.from(actualKeys).some((actualKey) => namesMatch(key, actualKey))
    );
  }

  // Чтение виртуализированного списка требует прокрутки, а прокрутка мешает
  // тому, кто в этот момент сам листает список. Поэтому скан откладывается,
  // пока человек занят панелью — но не дольше предела, иначе состав
  // перестанет обновляться совсем.
  const SCROLL_QUIET_MS = 1500;
  const MAX_DEFER_MS = 10000;

  function shouldDeferScan({ now, lastUserScrollAt, hovered, waitingSince } = {}) {
    const moment = Number(now) || 0;
    if (waitingSince && moment - waitingSince >= MAX_DEFER_MS) return false;
    if (hovered) return true;
    return Boolean(lastUserScrollAt) && moment - lastUserScrollAt < SCROLL_QUIET_MS;
  }

  // Отпечаток отрисованного раздела: пока он не меняется, DOM не пересоздаётся
  // и раздел не мигает при частых проверках.
  function missingSignature(missing, extras) {
    const rows = (missing || []).map((item) =>
      typeof item === "string" ? item : [item?.name, item?.icon, item?.presence].join("|")
    );
    const tail = Object.entries(extras || {})
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, value]) => `${key}=${value}`);
    return [...rows, ...tail].join("\n");
  }

  function localDateISO(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function addLocalDays(dateValue, days) {
    const [year, month, day] = String(dateValue).split("-").map(Number);
    const date = new Date(year, month - 1, day);
    date.setDate(date.getDate() + days);
    return localDateISO(date);
  }

  function validISODate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
    const [year, month, day] = value.split("-").map(Number);
    return localDateISO(new Date(year, month - 1, day)) === value;
  }

  function normalizeStatus(value, today = localDateISO()) {
    if (!value) return null;
    const source = typeof value === "string" ? { type: value } : value;
    if (!["vacation", "absent"].includes(source.type)) return null;

    const from = validISODate(source.from) ? source.from : null;
    const until = validISODate(source.until) ? source.until : null;
    if (from && until && from > until) return null;
    if (today && until && until < today) return null;
    return { type: source.type, from, until };
  }

  function statusIsActive(value, today = localDateISO()) {
    const status = normalizeStatus(value, null);
    if (!status) return false;
    return (!status.from || status.from <= today) && (!status.until || status.until >= today);
  }

  function statusFromPreset(type, preset, from, until, today = localDateISO()) {
    if (!["vacation", "absent"].includes(type)) return null;
    if (preset === "today") return { type, from: today, until: today };
    if (preset === "tomorrow") {
      const tomorrow = addLocalDays(today, 1);
      return { type, from: tomorrow, until: tomorrow };
    }
    if (preset === "range") return normalizeStatus({ type, from, until }, null);
    return { type, from: null, until: null };
  }

  function formatStatusPeriod(value, includeYear = false) {
    const status = normalizeStatus(value, null);
    if (!status) return "";
    const formatDate = (dateValue) => {
      const [year, month, day] = dateValue.split("-");
      return includeYear ? `${day}.${month}.${year}` : `${day}.${month}`;
    };
    if (!status.from && !status.until) return "без срока";
    if (status.from && status.from === status.until) return formatDate(status.from);
    if (status.from && status.until) return `${formatDate(status.from)}–${formatDate(status.until)}`;
    if (status.from) return `с ${formatDate(status.from)}`;
    return `до ${formatDate(status.until)}`;
  }

  root.VRMeetups = {
    normalizeName,
    comparisonKey,
    parseExpected,
    initials,
    roomKey,
    rosterById,
    rosterForRoom,
    participantMatchKeys,
    rosterMatchKeys,
    nameTokens,
    namesMatch,
    participantIsPresent,
    shouldDeferScan,
    missingSignature,
    localDateISO,
    addLocalDays,
    normalizeStatus,
    statusIsActive,
    statusFromPreset,
    formatStatusPeriod
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.VRMeetups;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

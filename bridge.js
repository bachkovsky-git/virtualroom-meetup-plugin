(function (root) {
  "use strict";

  // Мост между миром страницы (page-hook.js) и миром расширения
  // (participants-source.js). Данные непривилегированные: они лишь меняют
  // содержимое нашего информационного блока и никуда не отправляются, поэтому
  // токен-рукопожатие не вводится (мир страницы всё равно видит оба конца
  // postMessage). Защита — маркер SOURCE, белый список типов, строгая
  // структурная проверка payload; имена дальше проходят обычную нормализацию
  // как недоверенный ввод и вставляются через textContent.

  const SOURCE = "vrm-attendance-v1";

  // START и REFRESH идут со стороны расширения, STATUS и PARTICIPANTS — со
  // страницы.
  const TYPES = ["HOOK_START", "REFRESH", "HOOK_STATUS", "PARTICIPANTS"];

  function envelope(type, payload) {
    return { source: SOURCE, type, payload: payload || {} };
  }

  function parseEnvelope(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    if (data.source !== SOURCE) return null;
    if (!TYPES.includes(data.type)) return null;
    const payload = data.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return { type: data.type, payload };
  }

  // Тот же порядок и та же чистка, что у клиента VirtualRoom при выводе
  // участника в списке (паттерн «Фамилия Имя Отчество»).
  function formatWireName(user) {
    if (!user || typeof user !== "object") return "";
    return [user.lastName, user.firstName, user.middleName]
      .filter((part) => typeof part === "string" && part)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Участник может прийти wire-объектом {firstName, lastName, …} или
  // view-моделью с вложенным user — берём то, из чего собирается имя.
  function participantName(entry) {
    if (!entry || typeof entry !== "object") return "";
    const direct = formatWireName(entry);
    if (direct) return direct;
    return formatWireName(entry.user);
  }

  function participantIsBot(entry) {
    return entry?.type === "bot" || entry?.user?.type === "bot";
  }

  function namesFromParticipants(list) {
    if (!Array.isArray(list)) return [];
    const names = [];
    list.forEach((entry) => {
      if (participantIsBot(entry)) return;
      const name = participantName(entry);
      if (name) names.push(name);
    });
    return names;
  }

  function validParticipantsPayload(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (!Number.isFinite(payload.seq)) return false;
    if (!Array.isArray(payload.names)) return false;
    return payload.names.every((name) => typeof name === "string");
  }

  root.VRMBridge = {
    SOURCE,
    envelope,
    parseEnvelope,
    formatWireName,
    namesFromParticipants,
    validParticipantsPayload
  };

  // Экспорт только вне браузера: этот файл попадает в мир страницы на любых
  // сайтах, и трогать там чужой глобальный module нельзя.
  if (typeof window === "undefined" && typeof module !== "undefined" && module.exports) {
    module.exports = root.VRMBridge;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

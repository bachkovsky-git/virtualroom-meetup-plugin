(function (root) {
  "use strict";

  // Пользователи Mattermost часто заполняют «Имя»/«Фамилия» в разном порядке,
  // поэтому имя собирается как есть: сравнение в common.js всё равно
  // игнорирует порядок слов.
  const EMOJI = {
    palm_tree: "🌴",
    beach_with_umbrella: "🏖️",
    desert_island: "🏝️",
    airplane: "✈️",
    luggage: "🧳",
    sunny: "☀️",
    umbrella_on_ground: "⛱️",
    sneezing_face: "🤧",
    face_with_thermometer: "🤒",
    mask: "😷",
    face_with_head_bandage: "🤕",
    hospital: "🏥",
    pill: "💊",
    thermometer: "🌡️",
    microbe: "🦠",
    hamburger: "🍔",
    green_apple: "🍏",
    apple: "🍎",
    fork_and_knife: "🍴",
    knife_fork_plate: "🍽️",
    pizza: "🍕",
    ramen: "🍜",
    bento: "🍱",
    sandwich: "🥪",
    coffee: "☕",
    tea: "🍵",
    cake: "🍰",
    bus: "🚌",
    car: "🚗",
    red_car: "🚗",
    blue_car: "🚙",
    taxi: "🚕",
    train: "🚆",
    train2: "🚆",
    metro: "🚇",
    bike: "🚲",
    runner: "🏃",
    walking: "🚶",
    house: "🏠",
    house_with_garden: "🏡",
    hotel: "🏨",
    calendar: "📅",
    spiral_calendar_pad: "🗓️",
    date: "📅",
    busts_in_silhouette: "👥",
    speaking_head_in_silhouette: "🗣️",
    telephone_receiver: "📞",
    headphones: "🎧",
    computer: "💻",
    keyboard: "⌨️",
    memo: "📝",
    books: "📚",
    mortar_board: "🎓",
    brain: "🧠",
    zzz: "💤",
    sleeping: "😴",
    coffee_break: "☕",
    no_entry: "⛔",
    no_entry_sign: "🚫",
    hourglass: "⌛",
    hourglass_flowing_sand: "⏳",
    clock3: "🕒",
    alarm_clock: "⏰",
    baby: "👶",
    family: "👪",
    hospital_bed: "🛏️",
    bed: "🛏️",
    tooth: "🦷",
    syringe: "💉",
    briefcase: "💼",
    office: "🏢",
    hammer_and_wrench: "🛠️",
    fire: "🔥",
    rocket: "🚀",
    bug: "🐛",
    warning: "⚠️",
    star: "⭐",
    heart: "❤️",
    smile: "😄",
    slightly_smiling_face: "🙂",
    thinking_face: "🤔",
    face_with_monocle: "🧐",
    raised_hand: "✋",
    wave: "👋",
    ok_hand: "👌",
    muscle: "💪",
    tada: "🎉",
    birthday: "🎂",
    gift: "🎁",
    christmas_tree: "🎄",
    snowflake: "❄️",
    umbrella: "☔",
    dart: "🎯",
    checkered_flag: "🏁",
    soccer: "⚽",
    weight_lifter: "🏋️",
    swimmer: "🏊",
    ski: "🎿",
    mountain: "⛰️",
    camping: "🏕️",
    tent: "⛺",
    anchor: "⚓",
    ship: "🚢",
    helicopter: "🚁",
    truck: "🚚",
    ambulance: "🚑",
    police_car: "🚓"
  };

  // Порядок важен: первое подходящее правило выигрывает.
  const KIND_RULES = [
    {
      kind: "vacation",
      icon: "🌴",
      label: "в отпуске",
      emoji: ["palm_tree", "beach_with_umbrella", "desert_island", "airplane", "luggage", "umbrella_on_ground", "camping", "tent", "ski"],
      text: [/отпуск/i, /vacation/i, /holiday/i, /отгул/i, /\bpto\b/i]
    },
    {
      kind: "sick",
      icon: "🤒",
      label: "на больничном",
      emoji: ["sneezing_face", "face_with_thermometer", "mask", "face_with_head_bandage", "hospital", "pill", "thermometer", "microbe", "syringe", "tooth"],
      text: [/больн/i, /болею/i, /sick/i, /врач/i, /doctor/i]
    },
    {
      kind: "lunch",
      icon: "🍔",
      label: "на обеде",
      emoji: ["hamburger", "green_apple", "apple", "fork_and_knife", "knife_fork_plate", "pizza", "ramen", "bento", "sandwich", "coffee", "tea", "cake"],
      text: [/обед/i, /lunch/i, /ланч/i, /перекус/i, /кофе/i]
    },
    {
      kind: "meeting",
      icon: "📅",
      label: "на встрече",
      emoji: ["calendar", "spiral_calendar_pad", "date", "busts_in_silhouette", "speaking_head_in_silhouette", "telephone_receiver", "headphones"],
      text: [/встреч/i, /meeting/i, /созвон/i, /совещ/i, /интервью/i, /собес/i]
    },
    {
      kind: "away",
      icon: "🚌",
      label: "отсутствует",
      emoji: ["bus", "car", "red_car", "blue_car", "taxi", "train", "train2", "metro", "bike", "runner", "walking", "truck", "ship", "helicopter"],
      text: [/в пути/i, /уехал/i, /отсут/i, /дорог/i, /away/i, /afk/i]
    },
    {
      kind: "remote",
      icon: "🏠",
      label: "работает удалённо",
      emoji: ["house", "house_with_garden", "hotel", "computer", "keyboard"],
      text: [/удал[её]нн/i, /из дома/i, /wfh/i, /remote/i]
    },
    {
      kind: "busy",
      icon: "⛔",
      label: "занят",
      emoji: ["no_entry", "no_entry_sign", "hourglass", "hourglass_flowing_sand", "zzz", "sleeping", "brain", "memo", "books"],
      text: [/занят/i, /busy/i, /не беспоко/i, /focus/i, /фокус/i]
    }
  ];

  const PRESENCE = {
    online: { tone: "online", label: "в сети" },
    away: { tone: "away", label: "отошёл" },
    dnd: { tone: "dnd", label: "не беспокоить" },
    offline: { tone: "offline", label: "не в сети" }
  };

  const NO_EXPIRY = /^0001-01-01/;

  // Адрес по умолчанию: в большинстве случаев вводить его руками не нужно.
  const DEFAULT_BASE_URL = "https://matter.organization.ru";

  // Кеш команд и каналов переживает закрытие окна, поэтому его форму нужно
  // проверять и на чтении, и на записи.
  function normalizeLists(raw) {
    const teams = (Array.isArray(raw?.teams) ? raw.teams : [])
      .filter((team) => team?.id)
      .map((team) => ({
        id: String(team.id),
        name: String(team.name || ""),
        displayName: String(team.displayName || team.name || team.id)
      }));

    const channels = {};
    Object.entries(raw?.channels || {}).forEach(([teamId, list]) => {
      if (!teamId || !Array.isArray(list)) return;
      const cleaned = list
        .filter((channel) => channel?.id)
        .map((channel) => ({
          id: String(channel.id),
          name: String(channel.name || ""),
          displayName: String(channel.displayName || channel.name || channel.id),
          private: channel.private === true
        }));
      if (cleaned.length) channels[String(teamId)] = cleaned;
    });

    return { teams, channels, fetchedAt: Number(raw?.fetchedAt) || 0 };
  }

  function apiUrl(baseUrl, path) {
    return `${String(baseUrl || "").replace(/\/+$/, "")}/api/v4${path}`;
  }

  function originOf(baseUrl) {
    try {
      return new URL(String(baseUrl)).origin;
    } catch (_error) {
      return "";
    }
  }

  function normalizeBaseUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const url = new URL(withScheme);
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch (_error) {
      return "";
    }
  }

  function displayName(user) {
    const full = [user?.first_name, user?.last_name]
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" ");
    return full || String(user?.nickname || "").trim() || String(user?.username || "").trim();
  }

  function memberAliases(user) {
    const name = displayName(user);
    const nameKey = VRMeetups.comparisonKey(name);
    return Array.from(new Set([user?.username, user?.nickname]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .filter((value) => VRMeetups.comparisonKey(value) !== nameKey)));
  }

  function parseExpiry(value) {
    const raw = String(value || "").trim();
    if (!raw || NO_EXPIRY.test(raw)) return null;
    const timestamp = Date.parse(raw);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function classify(emojiName, text) {
    const name = String(emojiName || "").replace(/^:|:$/g, "");
    const rule = KIND_RULES.find((item) =>
      item.emoji.includes(name) || item.text.some((pattern) => pattern.test(String(text || "")))
    );
    return {
      kind: rule?.kind || "other",
      icon: EMOJI[name] || rule?.icon || "💬",
      label: rule?.label || ""
    };
  }

  // Кастомный статус живёт в props.customStatus строкой с JSON внутри.
  function parseCustomStatus(user, now = Date.now()) {
    const raw = user?.props?.customStatus ?? user?.customStatus;
    if (!raw) return null;
    let data = raw;
    if (typeof raw === "string") {
      try {
        data = JSON.parse(raw);
      } catch (_error) {
        return null;
      }
    }
    const emoji = String(data?.emoji || "").trim();
    const text = String(data?.text || "").trim();
    if (!emoji && !text) return null;

    const expiresAt = parseExpiry(data?.expires_at);
    if (expiresAt !== null && expiresAt <= now) return null;
    return { emoji, text, expiresAt, ...classify(emoji, text) };
  }

  function formatAgo(timestamp, now = Date.now()) {
    if (!timestamp) return "";
    const minutes = Math.floor((now - timestamp) / 60000);
    if (minutes < 0) return "только что";
    if (minutes < 2) return "только что";
    if (minutes < 60) return `${minutes} мин назад`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} ч назад`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "вчера";
    if (days < 7) return `${days} дн назад`;
    const date = new Date(timestamp);
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${day}.${month}`;
  }

  function presence(member, now = Date.now()) {
    const base = PRESENCE[member?.status] || PRESENCE.offline;
    const ago = member?.status === "online" ? "" : formatAgo(member?.lastActivityAt, now);
    return {
      tone: base.tone,
      label: base.label,
      ago,
      short: base.tone === "online" ? base.label : [base.label, ago].filter(Boolean).join(", ")
    };
  }

  function formatExpiry(timestamp, now = Date.now()) {
    if (!timestamp) return "";
    const date = new Date(timestamp);
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const today = VRMeetups.localDateISO(new Date(now));
    const stamp = VRMeetups.localDateISO(date);
    if (stamp === today) return `до ${time}`;
    if (stamp === VRMeetups.addLocalDays(today, 1)) return `до завтра, ${time}`;
    return `до ${day}.${month}`;
  }

  // Строка для подсказки: «🌴 В отпуске (до 14.07) · не в сети, 2 ч назад».
  function describe(member, now = Date.now()) {
    const parts = [];
    const status = member?.customStatus;
    if (status) {
      const title = status.text || status.label;
      const expiry = formatExpiry(status.expiresAt, now);
      parts.push([`${status.icon} ${title}`.trim(), expiry ? `(${expiry})` : ""].filter(Boolean).join(" "));
    }
    parts.push(presence(member, now).short);
    return parts.filter(Boolean).join(" · ");
  }

  // Иконка для кружка: кастомный статус важнее presence.
  function memberIcon(member) {
    if (member?.customStatus) return member.customStatus.icon;
    return null;
  }

  function memberFromUser(user, status, now = Date.now()) {
    return {
      id: user?.id || "",
      username: String(user?.username || ""),
      name: displayName(user),
      aliases: memberAliases(user),
      status: status?.status || "offline",
      manual: Boolean(status?.manual),
      lastActivityAt: Number(status?.last_activity_at) || 0,
      dndEndTime: Number(status?.dnd_end_time) || 0,
      customStatus: parseCustomStatus(user, now)
    };
  }

  // К комнате VirtualRoom привязывают каналы митапов и встреч, поэтому в
  // выпадающем списке они идут первыми — иначе нужный канал приходится
  // искать среди полутора сотен остальных.
  const MEETUP_PATTERN = /meetup|meeting|митап/i;

  function isMeetupChannel(channel) {
    return MEETUP_PATTERN.test(`${channel?.name || ""} ${channel?.displayName || ""}`);
  }

  function compareChannels(first, second) {
    const byMeetup = Number(isMeetupChannel(second)) - Number(isMeetupChannel(first));
    return byMeetup ||
      String(first?.displayName || "").localeCompare(String(second?.displayName || ""), "ru");
  }

  function sourceKey(source) {
    if (!source || source.type !== "mattermost") return "";
    return `${normalizeBaseUrl(source.baseUrl)}#${source.channelId || source.channelName || ""}`;
  }

  function isMattermost(roster) {
    return roster?.source?.type === "mattermost";
  }

  // Состав канала -> участники списка. Ручные статусы и псевдонимы,
  // добавленные руками, сохраняются.
  function applySnapshot(roster, members) {
    const participants = members.map((member) => member.name).filter(Boolean);
    const aliases = { ...(roster?.aliases || {}) };
    members.forEach((member) => {
      const key = VRMeetups.comparisonKey(member.name);
      if (!key) return;
      const existing = aliases[key] || [];
      const merged = [...existing];
      member.aliases.forEach((alias) => {
        if (!merged.some((item) => VRMeetups.comparisonKey(item) === VRMeetups.comparisonKey(alias))) {
          merged.push(alias);
        }
      });
      if (merged.length) aliases[key] = merged;
    });
    return { participants, aliases };
  }

  function membersByKey(members) {
    const map = new Map();
    (members || []).forEach((member) => {
      const keys = new Set([member.name, ...(member.aliases || [])].map(VRMeetups.comparisonKey));
      keys.forEach((key) => {
        if (key && !map.has(key)) map.set(key, member);
      });
    });
    return map;
  }

  // Кого звать в канал: отсутствующие без активного статуса. Свой статус
  // участника важнее статуса из Mattermost — тот же приоритет, что у строк
  // раздела «Не пришли». Истёкшие статусы из Mattermost отброшены ещё при
  // сборке снапшота.
  function pingTargets(missingNames, members, statuses, today) {
    const byKey = membersByKey(members);
    const findMember = (name) => {
      const key = VRMeetups.comparisonKey(name);
      if (byKey.has(key)) return byKey.get(key);
      for (const [memberKey, member] of byKey) {
        if (VRMeetups.namesMatch(memberKey, key)) return member;
      }
      return null;
    };
    const mentions = [];
    const excused = [];
    (missingNames || []).forEach((name) => {
      const own = statuses?.[VRMeetups.comparisonKey(name)];
      if (VRMeetups.statusIsActive(own, today)) {
        excused.push({ name, reason: own.type === "vacation" ? "в отпуске" : "отсутствует" });
        return;
      }
      const member = findMember(name);
      if (member?.customStatus) {
        excused.push({ name, reason: member.customStatus.label || member.customStatus.text || "статус" });
        return;
      }
      mentions.push({ name, username: member?.username || null });
    });
    return { mentions, excused };
  }

  // Участник без члена канала упоминается просто по имени: тегнуть некого,
  // но людям в канале всё равно видно, кого ждут.
  function pingMessage(mentions, meetingName) {
    if (!Array.isArray(mentions) || !mentions.length) return "";
    const tags = mentions.map((item) => (item.username ? `@${item.username}` : item.name)).join(" ");
    const title = String(meetingName || "").trim();
    return title ? `Ждём вас на встрече «${title}»: ${tags}` : `Ждём вас на встрече: ${tags}`;
  }

  root.VRMattermost = {
    EMOJI,
    KIND_RULES,
    DEFAULT_BASE_URL,
    normalizeLists,
    apiUrl,
    originOf,
    normalizeBaseUrl,
    displayName,
    memberAliases,
    parseExpiry,
    classify,
    parseCustomStatus,
    formatAgo,
    formatExpiry,
    presence,
    describe,
    memberIcon,
    memberFromUser,
    isMeetupChannel,
    compareChannels,
    sourceKey,
    isMattermost,
    pingTargets,
    pingMessage,
    applySnapshot,
    membersByKey
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.VRMattermost;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

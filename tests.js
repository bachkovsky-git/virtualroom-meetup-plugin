"use strict";

// Тесты чистой логики: сравнение имён, статусы и разбор данных Mattermost.
// Запуск: node tests.js
const VRMeetups = require("./common.js");
const VRMattermost = require("./mattermost.js");

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks += 1;
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    failures += 1;
    console.error(`FAIL ${name}\n  ожидалось: ${JSON.stringify(expected)}\n  получено:  ${JSON.stringify(actual)}`);
  }
}

// --- common.js -------------------------------------------------------------

check("порядок слов не важен",
  VRMeetups.comparisonKey("Иван Иванов"), VRMeetups.comparisonKey("Иванов Иван"));
check("ё приравнивается к е",
  VRMeetups.comparisonKey("Артём"), VRMeetups.comparisonKey("Артем"));
check("parseExpected убирает дубли и маркеры",
  VRMeetups.parseExpected("- Иван Иванов\nИванов Иван\n; Мария Петрова"),
  ["Иван Иванов", "Мария Петрова"]);
check("инициалы", VRMeetups.initials("Иван Иванов"), "ИИ");

// Отчество может быть указано только в одном из источников.
check("отчество в комнате, в списке без него",
  VRMeetups.namesMatch("Сидоров Алексей", "Сидоров Алексей Петрович"), true);
check("отчество в списке, в комнате без него",
  VRMeetups.namesMatch("Сидоров Алексей Петрович", "Сидоров Алексей"), true);
check("порядок слов с отчеством не важен",
  VRMeetups.namesMatch("Алексей Петрович Сидоров", "Сидоров Алексей"), true);
check("однофамильцы с разными именами не путаются",
  VRMeetups.namesMatch("Сидоров Алексей Петрович", "Сидоров Игорь"), false);
check("одной фамилии для совпадения мало",
  VRMeetups.namesMatch("Сидоров", "Сидоров Алексей Петрович"), false);
check("разные люди не совпадают",
  VRMeetups.namesMatch("Иванов Иван", "Петрова Мария"), false);
check("пустое имя ни с чем не совпадает", VRMeetups.namesMatch("", "Иванов Иван"), false);

const patronymicRoster = { participants: ["Сидоров Алексей", "Иванов Иван"], aliases: {} };
check("человек с отчеством в комнате считается пришедшим",
  VRMeetups.participantIsPresent(patronymicRoster, "Сидоров Алексей", ["Сидоров Алексей Петрович"]), true);
check("отсутствующий по-прежнему отсутствует",
  VRMeetups.participantIsPresent(patronymicRoster, "Иванов Иван", ["Сидоров Алексей Петрович"]), false);
check("просроченный статус снимается",
  VRMeetups.normalizeStatus({ type: "vacation", from: "2026-07-01", until: "2026-07-02" }, "2026-07-03"), null);
check("статус в периоде активен",
  VRMeetups.statusIsActive({ type: "absent", from: "2026-07-01", until: "2026-07-05" }, "2026-07-03"), true);

// --- common.js: откладывание проверки и отпечаток раздела -------------------

const t0 = Date.parse("2026-08-03T12:00:00Z");
check("скроллит прямо сейчас — ждём",
  VRMeetups.shouldDeferScan({ now: t0, lastUserScrollAt: t0 - 300, waitingSince: t0 - 300 }), true);
check("курсор над панелью — ждём",
  VRMeetups.shouldDeferScan({ now: t0, hovered: true, waitingSince: t0 - 300 }), true);
check("после тишины сканируем",
  VRMeetups.shouldDeferScan({ now: t0, lastUserScrollAt: t0 - 2000, waitingSince: t0 - 2000 }), false);
check("никто не трогал список — сканируем сразу",
  VRMeetups.shouldDeferScan({ now: t0 }), false);
check("дольше предела не ждём даже под курсором",
  VRMeetups.shouldDeferScan({ now: t0, hovered: true, waitingSince: t0 - 11000 }), false);

const rowsA = [{ name: "Иванов Иван", icon: "🌴", presence: "не в сети, 2 ч назад" }];
const extrasA = { count: "1/11", roster: "Митап", collapsed: false, notice: "" };
check("одинаковые данные — одинаковый отпечаток",
  VRMeetups.missingSignature(rowsA, extrasA), VRMeetups.missingSignature(rowsA, extrasA));
check("сменился статус — отпечаток другой",
  VRMeetups.missingSignature([{ ...rowsA[0], icon: "🍔" }], extrasA) === VRMeetups.missingSignature(rowsA, extrasA),
  false);
check("сменилось присутствие — отпечаток другой",
  VRMeetups.missingSignature([{ ...rowsA[0], presence: "в сети" }], extrasA) === VRMeetups.missingSignature(rowsA, extrasA),
  false);
check("добавился человек — отпечаток другой",
  VRMeetups.missingSignature([...rowsA, { name: "Петрова Мария", icon: "", presence: "" }], extrasA) ===
    VRMeetups.missingSignature(rowsA, extrasA),
  false);
check("свернули раздел — отпечаток другой",
  VRMeetups.missingSignature(rowsA, { ...extrasA, collapsed: true }) === VRMeetups.missingSignature(rowsA, extrasA),
  false);

// --- common.js: привязка списка к встрече ------------------------------------

check("счётчик непрочитанного отбрасывается",
  VRMeetups.roomTitleKey("(3) Alpha Daily — VirtualRoom"), "alpha daily");
check("хвост приложения отрезается",
  VRMeetups.roomTitleKey("Бэкенд-митап | VirtualRoom"), "бэкенд-митап");
check("лишние пробелы схлопываются",
  VRMeetups.roomTitleKey("  VR2   релиз  "), "vr2 релиз");
check("слишком короткое название не годится", VRMeetups.roomTitleKey("VR"), "");
check("пустой заголовок не годится", VRMeetups.roomTitleKey(""), "");

// Адрес комнаты VirtualRoom несёт одноразовые части: таймстамп против кеша и
// идентификатор сессии. Без их удаления привязка не находится ни разу.
const entryOne = "https://vr.example.com/room?_=1730180180958&userSession=dfcb46f1-f98f-4bcb-83f2-87da49fe077d";
const entryTwo = "https://vr.example.com/room?_=1730180999111&userSession=99999999-0000-4bcb-83f2-87da49fe077d";
check("повторный заход даёт тот же ключ", VRMeetups.roomKey(entryOne), VRMeetups.roomKey(entryTwo));
check("одноразовые параметры выброшены", VRMeetups.roomKey(entryOne), "https://vr.example.com/room");
check("осмысленные параметры остаются",
  VRMeetups.roomKey("https://vr.example.com/room?id=42&_=17301801"), "https://vr.example.com/room?id=42");
check("порядок параметров не важен",
  VRMeetups.roomKey("https://vr.example.com/r?b=2&a=1"), VRMeetups.roomKey("https://vr.example.com/r?a=1&b=2"));
check("фрагмент после # не учитывается",
  VRMeetups.roomKey("https://vr.example.com/room#tab"), "https://vr.example.com/room");

check("общий адрес не считается конкретным",
  VRMeetups.roomKeyIsSpecific("https://vr.example.com/room"), false);
check("адрес с идентификатором комнаты конкретен",
  VRMeetups.roomKeyIsSpecific("https://vr.example.com/room/42"), true);
check("адрес с параметром конкретен",
  VRMeetups.roomKeyIsSpecific("https://vr.example.com/room?id=42"), true);

check("старые привязки переезжают на новый ключ",
  VRMeetups.rekeyByRoom({ [entryOne]: "r1" }), { "https://vr.example.com/room": "r1" });

const genericState = {
  rosters: [{ id: "r1", name: "Первый" }, { id: "r2", name: "Второй" }],
  roomAssignments: { "https://vr.example.com/room": "r1" },
  titleAssignments: { "дейли alpha": "r2" }
};
check("при общем адресе выигрывает название встречи",
  VRMeetups.assignedRoster(genericState, "https://vr.example.com/room", "дейли alpha")?.id, "r2");
check("при общем адресе без названия остаётся привязка по адресу",
  VRMeetups.assignedRoster(genericState, "https://vr.example.com/room", "")?.id, "r1");

const specificState = {
  rosters: [{ id: "r1", name: "Первый" }, { id: "r2", name: "Второй" }],
  roomAssignments: { "https://vr.example.com/room/42": "r1" },
  titleAssignments: { "дейли alpha": "r2" }
};
check("при конкретном адресе выигрывает адрес",
  VRMeetups.assignedRoster(specificState, "https://vr.example.com/room/42", "дейли alpha")?.id, "r1");

check("название встречи без счётчика непрочитанного",
  VRMeetups.roomTitle("(3) Alpha Daily — VirtualRoom"), "Alpha Daily");
check("название встречи без хвоста приложения",
  VRMeetups.roomTitle("Бэкенд-митап | VirtualRoom"), "Бэкенд-митап");
check("регистр названия встречи сохраняется",
  VRMeetups.roomTitle("  VR2   Релиз  "), "VR2 Релиз");
check("пустой заголовок даёт пустое название", VRMeetups.roomTitle(""), "");
check("ключ встречи строится из названия",
  VRMeetups.roomTitleKey("(3) Alpha Daily — VirtualRoom"),
  VRMeetups.roomTitle("(3) Alpha Daily — VirtualRoom").toLocaleLowerCase("ru-RU"));

const bindState = {
  rosters: [{ id: "r1", name: "Alpha Daily" }, { id: "r2", name: "VR2 релиз" }],
  roomAssignments: { "https://vr.example.com/room/7": "r1" },
  titleAssignments: { "vr2 релиз": "r2" },
  selectedRosterId: "r2"
};
check("привязка по адресу комнаты",
  VRMeetups.assignedRoster(bindState, "https://vr.example.com/room/7", "vr2 релиз")?.id, "r1");
check("адрес важнее названия",
  VRMeetups.assignedRoster(bindState, "https://vr.example.com/room/7", "vr2 релиз")?.id, "r1");
check("запасной ключ по названию встречи",
  VRMeetups.assignedRoster(bindState, "https://vr.example.com/room/99", "vr2 релиз")?.id, "r2");
check("нет привязки — нет списка",
  VRMeetups.assignedRoster(bindState, "https://vr.example.com/room/99", "другая встреча"), null);
check("в окне расширения запасной вариант остаётся",
  VRMeetups.rosterForRoom(bindState, "https://vr.example.com/room/99", "другая встреча")?.id, "r2");

// --- common.js: намерение открыть редактор ----------------------------------

const intentNow = Date.parse("2026-08-17T12:00:00Z");
check("намерение открыть список",
  VRMeetups.editorIntent({ rosterId: "r1", at: intentNow - 1000 }, intentNow), { rosterId: "r1", blank: false });
check("намерение создать новый",
  VRMeetups.editorIntent({ blank: true, at: intentNow }, intentNow), { rosterId: "", blank: true });
check("создание важнее переданного id",
  VRMeetups.editorIntent({ rosterId: "r1", blank: true, at: intentNow }, intentNow), { rosterId: "", blank: true });
check("просроченное намерение не применяется",
  VRMeetups.editorIntent({ rosterId: "r1", at: intentNow - 400000 }, intentNow), null);
check("пустое намерение не применяется", VRMeetups.editorIntent({ at: intentNow }, intentNow), null);
check("мусор не применяется", VRMeetups.editorIntent("строка", intentNow), null);
check("отсутствие намерения не ломает", VRMeetups.editorIntent(undefined, intentNow), null);
check("намерение без времени считается свежим",
  VRMeetups.editorIntent({ rosterId: "r1" }, intentNow), { rosterId: "r1", blank: false });

// --- common.js: высота области отсутствующих ---------------------------------

check("высота в разумных пределах сохраняется", VRMeetups.clampMissingHeight(220), 220);
check("слишком маленькая высота подтягивается к минимуму", VRMeetups.clampMissingHeight(10), 64);
check("слишком большая высота ограничивается", VRMeetups.clampMissingHeight(5000), 900);
check("ноль означает «высота не задана»", VRMeetups.clampMissingHeight(0), 0);
check("мусор означает «высота не задана»", VRMeetups.clampMissingHeight("много"), 0);
check("дробная высота округляется", VRMeetups.clampMissingHeight(180.6), 181);

// --- common.js: кеш последнего результата -----------------------------------

check("ключ кеша из комнаты и списка",
  VRMeetups.resultKey("https://vr.example.com/room/7", "r1"), "https://vr.example.com/room/7|r1");
check("без списка ключа нет", VRMeetups.resultKey("https://vr.example.com/room/7", ""), "");
check("без комнаты ключа нет", VRMeetups.resultKey("", "r1"), "");

const cacheEntries = {
  old: { savedAt: 1000, rows: [] },
  newer: { savedAt: 3000, rows: [] },
  middle: { savedAt: 2000, rows: [] }
};
check("кеш обрезается до свежих записей",
  Object.keys(VRMeetups.pruneCache(cacheEntries, 2)), ["newer", "middle"]);
check("мусор из кеша выбрасывается",
  Object.keys(VRMeetups.pruneCache({ ok: { savedAt: 1 }, "": { savedAt: 2 }, broken: null }, 5)), ["ok"]);
check("пустой кеш не ломает", VRMeetups.pruneCache(undefined, 3), {});

// --- mattermost.js: адрес и имена ------------------------------------------

check("адрес без схемы", VRMattermost.normalizeBaseUrl("mm.example.com"), "https://mm.example.com");
check("хвостовой слеш убирается", VRMattermost.normalizeBaseUrl("https://mm.example.com/"), "https://mm.example.com");
check("мусор не проходит", VRMattermost.normalizeBaseUrl("не адрес"), "");

const user = {
  id: "u1",
  username: "ivan.ivanov",
  first_name: "Иванов",
  last_name: "Иван",
  nickname: "",
  props: { customStatus: '{"emoji":"palm_tree","text":"В отпуске","expires_at":"2026-08-10T12:00:00Z"}' }
};
check("имя из профиля", VRMattermost.displayName(user), "Иванов Иван");
check("логин уходит в псевдонимы", VRMattermost.memberAliases(user), ["ivan.ivanov"]);
check("имя без профиля — логин",
  VRMattermost.displayName({ username: "nick", first_name: "", last_name: "" }), "nick");

// --- режимы списка ----------------------------------------------------------

check("список с каналом — режим Mattermost",
  VRMeetups.rosterMode({ source: { type: "mattermost", channelId: "c1" } }), "mattermost");
check("список без источника — ручной режим", VRMeetups.rosterMode({ source: null }), "manual");
check("список без поля source — ручной режим", VRMeetups.rosterMode({}), "manual");
check("чужой тип источника — ручной режим",
  VRMeetups.rosterMode({ source: { type: "slack" } }), "manual");

check("адрес по умолчанию проходит нормализацию без изменений",
  VRMattermost.normalizeBaseUrl(VRMattermost.DEFAULT_BASE_URL), VRMattermost.DEFAULT_BASE_URL);

// --- mattermost.js: кеш команд и каналов ------------------------------------

const rawLists = {
  teams: [
    { id: "t1", name: "acme", displayName: "Acme", extra: "лишнее" },
    { name: "без id" }
  ],
  channels: {
    t1: [
      { id: "c1", name: "vr2-backend-meeting", displayName: "vr2-backend-meeting", private: false },
      { id: "", name: "пустой id" }
    ],
    "": [{ id: "c9" }],
    t2: "не массив"
  },
  fetchedAt: 1234
};
const lists = VRMattermost.normalizeLists(rawLists);
check("команды без id отбрасываются", lists.teams, [{ id: "t1", name: "acme", displayName: "Acme" }]);
check("каналы приводятся к нужной форме",
  lists.channels.t1,
  [{ id: "c1", name: "vr2-backend-meeting", displayName: "vr2-backend-meeting", private: false }]);
check("команда без id не попадает в кеш", Object.keys(lists.channels), ["t1"]);
check("время загрузки сохраняется", lists.fetchedAt, 1234);
check("пустой кеш не ломает", VRMattermost.normalizeLists(undefined), { teams: [], channels: {}, fetchedAt: 0 });
check("повторная нормализация ничего не меняет", VRMattermost.normalizeLists(lists), lists);

// --- mattermost.js: кастомные статусы --------------------------------------

const now = Date.parse("2026-08-03T09:00:00Z");
const vacation = VRMattermost.parseCustomStatus(user, now);
check("отпуск распознан", [vacation.kind, vacation.icon, vacation.text], ["vacation", "🌴", "В отпуске"]);
check("срок статуса разобран", vacation.expiresAt, Date.parse("2026-08-10T12:00:00Z"));
check("просроченный статус не показывается",
  VRMattermost.parseCustomStatus({ props: { customStatus: '{"emoji":"bus","text":"","expires_at":"2026-08-01T10:00:00Z"}' } }, now),
  null);
check("бессрочный статус (0001-01-01)",
  VRMattermost.parseCustomStatus({ props: { customStatus: '{"emoji":"bus","text":"","expires_at":"0001-01-01T00:00:00Z"}' } }, now).expiresAt,
  null);
check("статуса нет", VRMattermost.parseCustomStatus({ props: {} }, now), null);
check("битый JSON не роняет", VRMattermost.parseCustomStatus({ props: { customStatus: "{" } }, now), null);

check("обед по эмодзи", VRMattermost.classify("hamburger", "На обеде").kind, "lunch");
check("больничный по эмодзи", VRMattermost.classify("sneezing_face", "").kind, "sick");
check("отсутствие по эмодзи", VRMattermost.classify("bus", "").kind, "away");
check("отпуск по тексту", VRMattermost.classify("sunny", "Отпуск до пятницы").kind, "vacation");
check("незнакомый статус — свой эмодзи",
  VRMattermost.classify("tada", "Днюха"), { kind: "other", icon: "🎉", label: "" });
check("совсем незнакомый эмодзи — запасная иконка",
  VRMattermost.classify("unknown_emoji_xyz", "").icon, "💬");

// --- mattermost.js: присутствие --------------------------------------------

check("в сети", VRMattermost.presence({ status: "online" }, now).short, "в сети");
check("офлайн со временем",
  VRMattermost.presence({ status: "offline", lastActivityAt: now - 2 * 3600000 }, now).short,
  "не в сети, 2 ч назад");
check("минуты", VRMattermost.formatAgo(now - 15 * 60000, now), "15 мин назад");
check("вчера", VRMattermost.formatAgo(now - 30 * 3600000, now), "вчера");
check("срок статуса на сегодня", VRMattermost.formatExpiry(now + 3600000, now).startsWith("до "), true);

// --- mattermost.js: состав канала ------------------------------------------

// Время передаётся явно: иначе проверки ломались бы, как только срок статуса
// в тестовых данных истечёт по календарю.
const members = [
  VRMattermost.memberFromUser(user, { status: "offline", last_activity_at: now - 3600000 }, now),
  VRMattermost.memberFromUser(
    { id: "u2", username: "kuznetsov.nick", first_name: "Кузнецов", last_name: "Никита", props: {} },
    { status: "online" },
    now
  )
];
check("описание участника",
  VRMattermost.describe(members[0], now), "🌴 В отпуске (до 10.08) · не в сети, 1 ч назад");
check("иконка статуса", VRMattermost.memberIcon(members[0]), "🌴");
check("без статуса иконки нет", VRMattermost.memberIcon(members[1]), null);

const applied = VRMattermost.applySnapshot({ aliases: { [VRMeetups.comparisonKey("Иванов Иван")]: ["Ivan I."] } }, members);
check("состав из канала", applied.participants, ["Иванов Иван", "Кузнецов Никита"]);
check("ручной псевдоним сохранён, логин добавлен",
  applied.aliases[VRMeetups.comparisonKey("Иванов Иван")], ["Ivan I.", "ivan.ivanov"]);
check("повторный импорт ничего не меняет",
  VRMattermost.applySnapshot({ aliases: applied.aliases }, members), applied);

const byKey = VRMattermost.membersByKey(members);
check("поиск по имени", byKey.get(VRMeetups.comparisonKey("Иван Иванов")).id, "u1");
check("поиск по логину", byKey.get(VRMeetups.comparisonKey("kuznetsov.nick")).id, "u2");

// --- mattermost.js: порядок каналов ----------------------------------------

check("канал митапа приоритетен",
  VRMattermost.isMeetupChannel({ name: "backend-meetups", displayName: "backend-meetups" }), true);
check("канал встречи приоритетен",
  VRMattermost.isMeetupChannel({ name: "vr2-backend-meeting", displayName: "vr2-backend-meeting" }), true);
check("русское название тоже ловится",
  VRMattermost.isMeetupChannel({ name: "abc123", displayName: "Митап по бэкенду" }), true);
check("обычный канал не приоритетен",
  VRMattermost.isMeetupChannel({ name: "vr2-issues", displayName: "vr2-issues" }), false);

const channels = [
  { name: "vr2-issues", displayName: "vr2-issues" },
  { name: "vr2-backend-meeting", displayName: "vr2-backend-meeting" },
  { name: "analysts-general", displayName: "analysts-general" },
  { name: "backend-meetups", displayName: "backend-meetups" },
  { name: "ai", displayName: "ai-ии-в мираполис" }
];
check("митапы и встречи идут первыми, внутри групп — по алфавиту",
  [...channels].sort(VRMattermost.compareChannels).map((channel) => channel.displayName),
  ["backend-meetups", "vr2-backend-meeting", "ai-ии-в мираполис", "analysts-general", "vr2-issues"]);

// --- совместимость со сравнением участников --------------------------------

const roster = { participants: applied.participants, aliases: applied.aliases };
check("человек найден по логину из Mattermost",
  VRMeetups.participantIsPresent(roster, "Иванов Иван", ["ivan.ivanov"]), true);
check("отсутствующий не найден",
  VRMeetups.participantIsPresent(roster, "Кузнецов Никита", ["ivan.ivanov"]), false);

console.log(failures ? `\n${failures} из ${checks} проверок не прошли` : `Все ${checks} проверок прошли`);
process.exit(failures ? 1 : 0);

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
check("просроченный статус снимается",
  VRMeetups.normalizeStatus({ type: "vacation", from: "2026-07-01", until: "2026-07-02" }, "2026-07-03"), null);
check("статус в периоде активен",
  VRMeetups.statusIsActive({ type: "absent", from: "2026-07-01", until: "2026-07-05" }, "2026-07-03"), true);

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

const members = [
  VRMattermost.memberFromUser(user, { status: "offline", last_activity_at: now - 3600000 }),
  VRMattermost.memberFromUser(
    { id: "u2", username: "lipanti.nick", first_name: "Липатников", last_name: "Никита", props: {} },
    { status: "online" }
  )
];
check("описание участника",
  VRMattermost.describe(members[0], now), "🌴 В отпуске (до 10.08) · не в сети, 1 ч назад");
check("иконка статуса", VRMattermost.memberIcon(members[0]), "🌴");
check("без статуса иконки нет", VRMattermost.memberIcon(members[1]), null);

const applied = VRMattermost.applySnapshot({ aliases: { [VRMeetups.comparisonKey("Иванов Иван")]: ["Ivan I."] } }, members);
check("состав из канала", applied.participants, ["Иванов Иван", "Липатников Никита"]);
check("ручной псевдоним сохранён, логин добавлен",
  applied.aliases[VRMeetups.comparisonKey("Иванов Иван")], ["Ivan I.", "ivan.ivanov"]);
check("повторный импорт ничего не меняет",
  VRMattermost.applySnapshot({ aliases: applied.aliases }, members), applied);

const byKey = VRMattermost.membersByKey(members);
check("поиск по имени", byKey.get(VRMeetups.comparisonKey("Иван Иванов")).id, "u1");
check("поиск по логину", byKey.get(VRMeetups.comparisonKey("lipanti.nick")).id, "u2");

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
  VRMeetups.participantIsPresent(roster, "Липатников Никита", ["ivan.ivanov"]), false);

console.log(failures ? `\n${failures} из ${checks} проверок не прошли` : `Все ${checks} проверок прошли`);
process.exit(failures ? 1 : 0);

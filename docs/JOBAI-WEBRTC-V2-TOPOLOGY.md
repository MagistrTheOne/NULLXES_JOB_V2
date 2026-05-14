# JobAI WebRTC ЧТЗ — зафиксированная топология V2 (NULLXES)

**Статус:** рабочее соглашение для реализации в монорепо до выноса сервисов по контракту с Заказчиком.

## Выбор деплоя

- **П.1 (прокси)** и **п.2 (ИИ-бэкенд)** в первой итерации реализуются **в одном процессе `realtime-gateway`**, чтобы фронт мог вызывать те же пути через Next ` /api/gateway/*` без отдельного микросервиса.
- Вынесение п.2 на отдельный хост включается переменными **`JOBAI_AI_AGENT_API_BASE_URL`** + **`JOBAI_AI_AGENT_API_TOKEN`**: gateway проксирует `POST /meetings/start` и `POST /meetings/stop` на этот базовый URL с тем же телом и `Authorization: Bearer <meetingControlKey>` где это требует ЧТЗ.

## LiveKit и ingress

- **Комната LiveKit и ingress** создаётся и сопровождается **контуром JobAI/LiveKit** (в т.ч. цель для ffmpeg). Gateway **не** вызывает LiveKit Room API (`createRoom` / `deleteRoom`).
- Имя комнаты для участника и JWT: **`nullxes-meeting-<numericMeetingId>`** (совпадает с внутренним `meetingId` оркестратора после старта).
- **JWT участника** выдаётся `POST /livekit/token` (или клиент использует `liveKitResponse.serverUrl` из `get-interview-livekit-data` + запрос токена).
- В **`liveKitResponse.ingress`** gateway пробрасывает строковые поля из тела интервью, пришедшего по webhook (см. `pickLiveKitIngressHintsFromInterview` — ключи не переименовываются).

## WebSocket п.2.4 (control)

- Путь апгрейда на gateway: **`/ws/meeting/<numericMeetingId>`** с заголовком **`Authorization: Bearer <meetingControlKey>`** — см. `MeetingControlWsHub`.

## Ограничение одного инстанса

- Учёт пингов и 60‑минутной сессии для п.1.4 / п.4.1 в текущей версии — **in-memory** в процессе gateway. Для горизонтального масштаба нужен общий стор (Redis) и перенос sweeper на координируемый воркер.

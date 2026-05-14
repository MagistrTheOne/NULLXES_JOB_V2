# JobAI WebRTC ЧТЗ — зафиксированная топология V2 (NULLXES)

**Статус:** рабочее соглашение для реализации в монорепо до выноса сервисов по контракту с Заказчиком.

## Выбор деплоя

- **П.1 (прокси)** и **п.2 (ИИ-бэкенд)** в первой итерации реализуются **в одном процессе `realtime-gateway`**, чтобы фронт мог вызывать те же пути через Next ` /api/gateway/*` без отдельного микросервиса.
- Вынесение п.2 на отдельный хост включается переменными **`JOBAI_AI_AGENT_API_BASE_URL`** + **`JOBAI_AI_AGENT_API_TOKEN`**: gateway проксирует `POST /meetings/start` и `POST /meetings/stop` на этот базовый URL с тем же телом и `Authorization: Bearer <meetingControlKey>` где это требует ЧТЗ.

## LiveKit

- **Создание и удаление комнаты** выполняет gateway через `RoomServiceClient` (LiveKit Cloud).
- Имя комнаты: **`nullxes-meeting-<numericMeetingId>`** (совпадает с внутренним `meetingId` оркестратора после старта).
- **JWT участника** по-прежнему выдаётся `POST /livekit/token` (или клиент использует данные из `liveKitResponse.serverUrl` + отдельный запрос токена).

## WebSocket п.2.4 (control)

- Путь апгрейда на gateway: **`/ws/meeting/<numericMeetingId>`** с заголовком **`Authorization: Bearer <meetingControlKey>`** — см. `MeetingControlWsHub`.

## Ограничение одного инстанса

- Учёт пингов и 60‑минутной сессии для п.1.4 / п.4.1 в текущей версии — **in-memory** в процессе gateway. Для горизонтального масштаба нужен общий стор (Redis) и перенос sweeper на координируемый воркер.

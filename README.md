# human-msg

Анонимный мессенджер (веб и Telegram-бот): вопрос уходит случайному свободному
человеку онлайн, ответ возвращается автору. Правила продукта описаны в
[`CLAUDE.md`](CLAUDE.md), устройство системы — в
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), план работ — в
[`docs/TASKS.md`](docs/TASKS.md).

> **Статус:** проект в разработке. Сейчас готов каркас репозитория (этап 0), самого
> приложения ещё нет: запускать можно проверки и базу данных, но не сервер.

## Локальный запуск

### Что нужно

- Node.js 22 (версия указана в `.nvmrc`; с `nvm` достаточно `nvm use`)
- pnpm 10 — ставится через Corepack, который идёт вместе с Node.js:
  `corepack enable`
- Docker с Docker Compose — для PostgreSQL

### Первый запуск

```bash
corepack enable
pnpm install

cp .env.example .env     # значения по умолчанию подходят для разработки
docker compose up -d     # PostgreSQL на 127.0.0.1:5432
```

Проверить, что база готова:

```bash
docker compose ps                                  # состояние должно быть healthy
pg_isready -h 127.0.0.1 -p 5432 -U humanmsg -d humanmsg
```

Остановить базу: `docker compose down`. Данные хранятся в томе `pgdata` и
переживают перезапуск; чтобы удалить их вместе с контейнером, используйте
`docker compose down -v`.

### Команды

| Команда             | Что делает                                            |
| ------------------- | ----------------------------------------------------- |
| `pnpm typecheck`    | Проверка типов всех пакетов                           |
| `pnpm lint`         | ESLint                                                |
| `pnpm format`       | Автоформатирование Prettier                           |
| `pnpm format:check` | Проверка форматирования без изменений                 |
| `pnpm test`         | Все тесты (Vitest), один прогон                       |
| `pnpm test:watch`   | Тесты в режиме наблюдения                             |

Перед пулл-реквестом должны проходить `typecheck`, `lint`, `format:check` и
`test`: то же самое проверяет CI на GitHub.

### Структура репозитория

```
apps/server/        серверный процесс (точка входа)
packages/shared/    общие типы, тексты, чистые функции
packages/db/        схема БД и миграции
packages/core/      бизнес-логика
docs/               архитектура и план задач
```

Позже добавятся `apps/web` (веб-интерфейс) и `apps/backoffice` (бэкофис).

### Облачные сессии Claude Code

В облачных сессиях Claude Code хук `.claude/hooks/session-start.sh` сам ставит
зависимости и поднимает PostgreSQL. На обычном компьютере он ничего не делает.

## Запуск на VPS

Инструкции пока нет: деплой появится на этапе 12 плана
([`docs/TASKS.md`](docs/TASKS.md)). Запланировано так:

- один VPS с Docker Compose: `caddy` (HTTPS и статика), `server` и `postgres`;
- ежедневные бэкапы базы;
- пошаговая инструкция `docs/DEPLOY.md` (VPS, домен, переменные окружения,
  Google OAuth, webhook бота, обновление) — задача 12.5.

Когда `docs/DEPLOY.md` будет готов, этот раздел сократится до ссылки на него.

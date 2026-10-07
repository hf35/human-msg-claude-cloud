# Main Plot
Мессенжер (веб и бот в телеграм) для возможности задать вопрос или поделиться мыслью с живым человеком. 
Каждое сообщение уходит случайному пользователю онлайн - который должен на него ответить и ответ улетит отправителю.

## Main Rules 

Мы хотим чтобы юзер всегда получал ответ на его сообщение

### Rules that must be enforced

1. **Replies are always allowed.** If a user has an unread incoming message,
   their message is treated as a *reply* to the last unread one
   (`handleMessage`). Never block this. If replies were blocked, a user who is
   awaiting a reply could not answer an incoming message, and neither side of
   the dialog could proceed.

2. **One message — one reply.** While a user is awaiting a reply, they cannot
   send a new message — neither to a random recipient nor to a manually chosen
   one. See `AWAITING_REPLY` in `src/locales/ru.js`.

3. **Busy users receive nothing.** Users with unread incoming messages are
   excluded from the random recipient pool (`getBusyUserIds`) and rejected for
   manual sends. **This rule must not apply to replies** — otherwise a busy
   user could never become free again.

4. **Replies are persisted as separate rows.** A reply is inserted into
   `messages` with `reply_message_id` pointing at the original, and the
   original is set to `replied = TRUE`. Never "answer" by only flipping the
   `replied` flag — the reply text would be lost and the conversation would be
   invisible in the web UI.

### Validation order

`handleMessage` (random routing) — order matters:
1. Unread incoming exists → reply.
2. Awaiting reply → reject (rule 2).
3. Otherwise → forward to a random free recipient (rule 3).

`sendMessageToUser` (manual recipient) — order matters:
1. Sender awaiting reply → reject (rule 2).
2. Unread incoming exists: from the chosen recipient → treat as reply and mark
   the original replied; from someone else → reject.
3. Chosen recipient is busy → reject (rule 3).
4. Otherwise → send.

Keep the "is this a reply?" check (`replyMessageId !== null`) *before* the busy
recipient check, otherwise rule 3 would block the very reply that rule 1 requires.

##  Improvments in Future, need to investigate

1. Поскольку мы хотим, чтобы юзер всегда получал ответ, возможно есть смысл отправлять вопрос не одному юзеру, 
а нескольким, и использовать ответ того кто ответит первый, но.. мы не хотим чтобы те кто отвечает торопились ответить
лишь бы быть быстрее.. возможно нам нужно давать какое то время каждому из них 5-10 минут... Решим после выполнения основной части
2. Возможно нам нужна система рейтинга, чтобы получив ответ - юзер мог выставлять оценки ответам. И в будущем пользователи с
 более высоким рейтингом получали больше вопросов
3. нам нужно будет как уметь преобразовывать айдишники юзеров в что то более читаемое и понятное - например прилагательные+животное или 
рандомные имени из телефонного справочника.. Но с сохранением анонимности
4. Мобильные платформы

# Development Guidelines

## Code Style and Format

### ES6 Module Format
All JavaScript files must use ES6 module format with `import`/`export` syntax instead of CommonJS `require`/`module.exports`.

Example:
```javascript
// Correct - ES6 import
import { Telegraf } from 'telegraf';
import bot from './bot/bot.js';

// Incorrect - CommonJS
const { Telegraf } = require('telegraf');
const bot = require('./bot/bot');
```

### Language Guidelines

#### Code Comments
All code comments must be written in **English**.

#### User-facing Messages
All user-facing messages (replies, notifications, etc.) must be written in **Russian**.

Example:
```javascript
// Comment in English
const handleMessage = async (ctx) => {
  // This is a comment in English
  await ctx.reply('Добро пожаловать в бот для пересылки сообщений!'); // Message in Russian
};
```


## Dependencies
- Use ES6 modules for all imports
- All dependencies are defined in package.json

## Architecture Overview

The project follows a backend-first architecture where:

1. **Main Backend Service** (`src/backend/`) - node.js предоставляет общую бизнес логику работы с сообщениями, связь с БД (postgress)
2. **Backoffice** (`src/backoffice`) - веб интерфейс на react для мониторинга новых юзеров, чтение переписок, возможность отправлять сообщения от имени конкретного юзера для тестирования, должен быть защищен логином\паролем которые задаются через конфиг
4. **API Layer** (`src/api/`) - Exposes backend functionality through REST endpoints
2. **Telegram Bot Interface** (`src/bot/`) - Optional interface to the main backend service
3. **Web UI** (`src/web/`) - веб интерфейс на react для общения. Можно залогинться через гугл и читать, отправлять сообщения


This architecture allows:
- Testing and development through web interface
- Simulating multiple users via web interface
- Separation of concerns between Telegram interface and core logic
- Easy integration with other systems through API


## File Structure
- All source code goes in `src/` directory
- Main entry point is `src/index.js`
- Backend API in `src/backend/`
- Bot logic in `src/bot/`
- Database logic in `src/database/`
- Services in `src/services/`
- Handlers in `src/bot/handlers/`
- Web UI in `src/webui/`
- API endpoints in `src/api/`

## API Endpoints

The following API endpoints are available:


### Terms

- **Unread message** — a message with `replied = FALSE` (the receiver has not answered).
- **Awaiting reply** — the user has an outgoing message with `replied = FALSE`.
- **Busy user** — the user has an unread *incoming* message.

Note that "awaiting reply" and "busy" are **different states**: a user can be
awaiting a reply to their own message while also being busy with someone else's.






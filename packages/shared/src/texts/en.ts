import type { Texts } from './index';

export const en: Texts = {
  buttons: {
    skip: 'Skip',
    report: 'Report',
  },

  rejections: {
    awaitingAnswer: 'You have already asked a question. Wait for the answer before asking another.',
    dailyLimitReached: (limit: number) =>
      `You have reached today's question limit (${limit}). Please try again later.`,
    messageEmpty: 'The message is empty. Write something.',
    messageTooShort: 'The message is too short. Write at least a few words.',
    messageTooLong: (maxLength: number) =>
      `The message is too long. The maximum is ${maxLength} characters.`,
    onlyText: 'Only text is supported for now.',
    answerTimeExpired:
      'Your time to answer is over: the question has already gone to someone else.',
  },

  notifications: {
    questionQueued: 'Looking for someone to answer your question…',
    questionAssigned: (alias: string, minutes: number) =>
      `You have a question from "${alias}". Answer within ${minutes} min or press "Skip".`,
    answerReceived: (alias: string) => `Answer from "${alias}"`,
    questionAndAnswer: (question: string, answer: string) =>
      `Your question:\n${question}\n\nAnswer:\n${answer}`,
    answerReminder: (minutes: number) =>
      `About ${minutes} min left. Answer the question or skip it.`,
    assignmentExpired: 'Your time to answer is over, the question has gone to someone else.',
    questionExpired:
      'Unfortunately, nobody had time to answer your question. You can ask it again.',
    autoDoNotDisturb: (count: number) =>
      `You missed ${count} questions in a row, so we switched off other people's questions. Send /resume to come back.`,
    skipped: 'Question skipped.',
    reported: 'Report received. You will not get questions from this person anymore.',
  },

  bot: {
    start: (alias: string) =>
      `Hi! Here you can ask a real person a question or answer someone else's. Your name here is "${alias}".\n\nJust write your question and it will go to a random person.`,
    help: 'Write a question and it goes to a random person; you will get an answer. If you receive someone else\'s question, answer it with a regular message or press "Skip".\n\n/stop - stop receiving other people\'s questions\n/resume - start receiving them again',
    stopped: "Okay, you will not get other people's questions anymore. Send /resume to come back.",
    resumed: "You're back - other people's questions will arrive again.",
  },

  web: {
    signIn: {
      title: 'Ask a real person',
      subtitle: 'Anonymous questions and answers: your question goes to a random person.',
      googleHint: 'Sign in with Google. Other users will only see your alias.',
      googleUnavailable: 'Google sign-in is not set up on this server.',
      devTitle: 'Development sign-in',
      devName: 'Name of the test user',
      devButton: 'Sign in without Google',
      failed: 'Could not sign in. Please try again.',
    },
    header: {
      signedInAs: (alias: string) => `You are "${alias}"`,
      signOut: 'Sign out',
      language: 'Language',
    },
    errors: {
      network: 'Cannot reach the server. Check your connection and try again.',
      loading: 'Loading…',
    },
    connection: {
      reconnecting: 'No connection to the server, reconnecting…',
    },
    ask: {
      title: 'Ask a question',
      placeholder: 'Write what you would like to ask…',
      send: 'Send',
      remaining: (count: number) => `Questions left today: ${count}`,
      assigned: 'Someone is already answering — waiting for the reply.',
    },
    incoming: {
      from: (alias: string) => `Question from "${alias}"`,
      timeLeft: (time: string) => `Time left: ${time}`,
      timeUp: 'Time is up',
      placeholder: 'Write your answer…',
      send: 'Answer',
      reportConfirm: 'You will no longer get questions from this person. Report?',
      reportYes: 'Yes, report',
      cancel: 'Cancel',
    },
    notice: {
      dismiss: 'Close',
    },
    state: {
      waiting: 'Your question is waiting for an answer:',
    },
  },

  errors: {
    generic: 'Something went wrong. Please try again in a moment.',
  },
};

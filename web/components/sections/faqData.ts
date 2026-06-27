export interface FaqItem {
  question: string;
  answer: string;
}

export const FAQ_ITEMS: FaqItem[] = [
  {
    question: "Does Zyon use my own WhatsApp number?",
    answer:
      "Yes. Zyon connects to your existing WhatsApp Business number through the official WhatsApp Business Platform. Your customers see the same number they already message.",
  },
  {
    question: "What happens when the AI isn’t sure?",
    answer:
      "It hands the conversation to your team instead of guessing. You can also take over any chat manually, and hand it back when you’re done.",
  },
  {
    question: "Can my staff and the AI both reply?",
    answer:
      "Yes. The AI and your team share one inbox. When a person takes over, the AI stays silent until the chat is returned to it.",
  },
  {
    question: "Who can see my conversations and customer data?",
    answer:
      "Only you. Each business is fully isolated on the platform. We don’t sell your data, and you can export or delete it on request.",
  },
  {
    question: "Which languages does it handle?",
    answer:
      "It replies in clear, natural language and handles the everyday English-and-local-language mix common in customer chats.",
  },
  {
    question: "Is this allowed by WhatsApp?",
    answer:
      "Yes. Zyon is built on Meta’s official WhatsApp Business Platform and follows WhatsApp’s messaging rules. It does not use unofficial automation that can get a number banned.",
  },
  {
    question: "What about AI Voice Calling?",
    answer:
      "AI Voice Calling is coming soon. The five products above are available today.",
  },
];

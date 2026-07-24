export interface FaqItem {
  question: string;
  answer: string;
}

export const FAQ_ITEMS: FaqItem[] = [
  {
    question: "Does Prantivo use my own WhatsApp number?",
    answer:
      "Yes. Prantivo connects to your existing WhatsApp Business number through the official WhatsApp Business Platform. Your customers see the same number they already message.",
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
      "It answers in Telugu, Hindi, and English, including the code-mixed speech common in everyday customer chats.",
  },
  {
    question: "Is this allowed by WhatsApp?",
    answer:
      "Yes. Prantivo is built on Meta’s official WhatsApp Business Platform and follows WhatsApp’s messaging rules. It does not use unofficial automation that can get a number banned.",
  },
  {
    question: "What about AI voice calling?",
    answer:
      "AI voice calling is coming soon. The WhatsApp AI receptionist — answering, booking, and handoff to your team — is available today.",
  },
];

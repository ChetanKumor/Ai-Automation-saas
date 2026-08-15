export interface FaqItem {
  question: string;
  answer: string;
}

export const FAQ_ITEMS: FaqItem[] = [
  {
    question: "What if it gives a patient the wrong price?",
    answer:
      "It quotes only what you loaded, word for word. It doesn’t estimate and it doesn’t guess. When it isn’t sure, it says so and brings in your staff instead of inventing an answer.",
  },
  {
    question: "Will it give medical advice?",
    answer:
      "No. It’s built not to. It handles prices, timings, doctors and appointments. Any clinical question goes to a person at your clinic.",
  },
  {
    question: "What happens if I go over my plan?",
    answer:
      "Nothing breaks. You’ll see a notice at 80% of your included usage and again at 90%, so there are no surprises. Past your included usage, extra replies bill at ₹0.75 each — or you move up a plan, which is usually cheaper. There’s a safety limit well above your included usage that stops the AI replying, and even then your team can still answer every message in the same thread. A patient never gets silence.",
  },
  {
    question: "What if my patients don’t want to talk to a machine?",
    answer:
      "They’re messaging your clinic’s number, in their own language, and getting an answer in seconds instead of the next morning. Your staff can step into any conversation at any point, and most patients never need them to.",
  },
  {
    question: "How long until it’s running?",
    answer: "We’ll give you a date before you sign, not after.",
  },
  {
    question: "What if it doesn’t work for my clinic?",
    answer:
      "There’s a 30-day exit. If it isn’t working for your clinic in the first month, you can leave.",
  },
  {
    question: "Does Prantivo use my own WhatsApp number?",
    answer:
      "Yes. Prantivo connects to your existing WhatsApp Business number through the official WhatsApp Business Platform. Your patients see the same number they already message.",
  },
  {
    question: "Can my staff and the AI both reply?",
    answer:
      "Yes. The AI and your team share one inbox. When a person takes over, the AI stays silent until the chat is returned to it.",
  },
  {
    question: "Who can see my conversations and patient data?",
    answer:
      "Only you. Each business is fully isolated on the platform. We don’t sell your data, and you can export or delete it on request.",
  },
  {
    question: "Which languages does it handle?",
    answer:
      "It answers in Telugu, Hindi, and English, including the code-mixed speech common in everyday patient conversations.",
  },
  {
    question: "Is this allowed by WhatsApp?",
    answer:
      "Yes. Prantivo is built on Meta’s official WhatsApp Business Platform and follows WhatsApp’s messaging rules. It does not use unofficial automation that can get a number banned.",
  },
  {
    question: "What about voice calling?",
    answer:
      "It’s next, not now. Today Prantivo handles WhatsApp. Voice is in development and you’ll be told the date when there is one, not before.",
  },
];

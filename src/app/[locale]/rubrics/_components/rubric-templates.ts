import type { Criterion } from "@/types/rubric";

export interface RubricTemplate {
  id: string;
  name: string;
  description: string;
  evaluation_mode: "prompt_response" | "conversational";
  scenario_description: string;
  expected_outcome: string;
  criteria: Criterion[];
}

export const RUBRIC_TEMPLATES: RubricTemplate[] = [
  {
    id: "customer-support-standard",
    name: "Customer Support Standard",
    description: "Evaluate agent replies to customer support tickets.",
    evaluation_mode: "prompt_response",
    scenario_description:
      "A customer submits a support request and an agent provides a written response.",
    expected_outcome:
      "The agent's reply is accurate, resolves the customer's issue, and maintains a professional and empathetic tone.",
    criteria: [
      {
        name: "Accuracy",
        weight: 0.4,
        steps: [
          "Verify all factual claims in the response are correct.",
          "Check that the proposed solution or information matches the customer's actual problem.",
          "Penalize responses that introduce incorrect information or mislead the customer.",
        ],
      },
      {
        name: "Resolution Quality",
        weight: 0.35,
        steps: [
          "Assess whether the response fully addresses the customer's question or request.",
          "Check that actionable next steps are clear and complete.",
          "Penalize vague or incomplete answers that leave the issue unresolved.",
        ],
      },
      {
        name: "Tone & Professionalism",
        weight: 0.25,
        steps: [
          "Evaluate whether the response is friendly, empathetic, and professional.",
          "Check for language that could come across as dismissive, condescending, or robotic.",
          "Reward responses that acknowledge the customer's frustration where appropriate.",
        ],
      },
    ],
  },
  {
    id: "sales-tone-verification",
    name: "Sales Tone Verification",
    description: "Verify that sales outreach is compelling and on-brand.",
    evaluation_mode: "prompt_response",
    scenario_description:
      "A sales representative sends an outreach email or message to a prospective customer.",
    expected_outcome:
      "The message is personalized, clearly communicates value, uses an engaging tone, and includes a clear call to action.",
    criteria: [
      {
        name: "Relevance & Personalization",
        weight: 0.35,
        steps: [
          "Check whether the message references specifics about the prospect or their company.",
          "Assess whether the value proposition is tailored to the prospect's likely needs.",
          "Penalize generic messaging that could apply to any recipient.",
        ],
      },
      {
        name: "Tone & Persuasiveness",
        weight: 0.35,
        steps: [
          "Evaluate whether the tone is confident without being pushy.",
          "Check that benefits are communicated clearly and compellingly.",
          "Reward messages that create a sense of relevance or urgency without resorting to pressure tactics.",
        ],
      },
      {
        name: "Call to Action",
        weight: 0.3,
        steps: [
          "Verify there is a clear, single call to action.",
          "Check that the ask is low-friction and easy to act on.",
          "Penalize messages with no CTA or with multiple competing asks.",
        ],
      },
    ],
  },
  {
    id: "conversational-ai-quality",
    name: "Conversational AI Quality",
    description: "Assess multi-turn chat responses for coherence and helpfulness.",
    evaluation_mode: "conversational",
    scenario_description:
      "A user engages in a multi-turn conversation with an AI assistant to complete a task or answer questions.",
    expected_outcome:
      "The assistant maintains context across turns, provides helpful and coherent responses, and gracefully handles ambiguity.",
    criteria: [
      {
        name: "Context Retention",
        weight: 0.35,
        steps: [
          "Check that the assistant correctly references information from earlier turns.",
          "Penalize responses that contradict or ignore prior context.",
          "Reward responses that build naturally on the conversation history.",
        ],
      },
      {
        name: "Helpfulness",
        weight: 0.4,
        steps: [
          "Assess whether the response meaningfully advances the user's goal.",
          "Check that information provided is accurate and directly relevant.",
          "Penalize responses that are technically correct but unhelpful in context.",
        ],
      },
      {
        name: "Clarity",
        weight: 0.25,
        steps: [
          "Evaluate whether the response is easy to understand.",
          "Check that complex topics are explained at an appropriate level for the user.",
          "Penalize overly verbose or unnecessarily technical language.",
        ],
      },
    ],
  },
  {
    id: "content-quality",
    name: "Content Quality",
    description: "Review generated content for accuracy, structure, and engagement.",
    evaluation_mode: "prompt_response",
    scenario_description:
      "An AI model generates written content such as a blog post, product description, or marketing copy.",
    expected_outcome:
      "The content is factually accurate, well-structured, engaging, and appropriate for its intended audience.",
    criteria: [
      {
        name: "Accuracy & Credibility",
        weight: 0.35,
        steps: [
          "Verify that all stated facts are correct.",
          "Check that claims are grounded and not exaggerated.",
          "Penalize content that includes unsupported or misleading statements.",
        ],
      },
      {
        name: "Structure & Clarity",
        weight: 0.35,
        steps: [
          "Assess whether the content has a clear introduction, body, and conclusion.",
          "Check that ideas flow logically from one to the next.",
          "Reward content that uses headings, lists, or other formatting effectively.",
        ],
      },
      {
        name: "Engagement",
        weight: 0.3,
        steps: [
          "Evaluate whether the writing is compelling and holds the reader's attention.",
          "Check that the tone matches the intended audience.",
          "Penalize dry, repetitive, or generic writing that fails to engage.",
        ],
      },
    ],
  },
];

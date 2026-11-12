// The one board Render should show. Inserted on startup when these ids are missing.
// The payout row records a PayPal sandbox batch that was already sent. It does not send money.
import type { Bounty, PayoutProposal, Submission } from "./store.js";

const reasoning =
  "The submission clearly explains how to claim a paid open-source bounty, which aligns well with the bounty's goal to guide first-time bounty hunters. It meets the acceptance criteria by being concrete and practical, covering how bounties work, the importance of acceptance criteria, the need to submit actual work, the scoring system, and payment procedures. The submission is well-structured and informative, showing proof of understanding the bounty description thoroughly. The writing is concise and stays focused, fulfilling all essential points for a beginner's guide effectively.";

export const demoBounty: Bounty = {
  id: "b_26c20bb7",
  title: "Write a guide for first-time bounty hunters",
  description:
    "We need a short public guide for someone who has never claimed a paid open-source bounty. Write it for a reader who can follow instructions but has never been paid for a pull request or an article. The piece should stand on its own. Do not mention Gentpay, this repository, or the hackathon. The 50.00 USD is the reward pool for accepted writing. Gentpay pays a share through PayPal sandbox only after a person approves it.",
  acceptanceCriteria: [
    "The submission is the finished guide itself, between 400 and 700 words, with a title and no code",
    "It tells the reader to check every acceptance criterion before starting, and to include proof for each one in the submission",
    "It explains that the posted amount is a shared reward pool, a score under 20 is unpaid, and a person approves the payment before PayPal sends it",
  ],
  amount: "50.00",
  currency: "USD",
  kind: "bounty",
  status: "open",
  createdAt: "2026-11-12T15:05:32.911Z",
};

export const demoSubmission: Submission = {
  id: "s_547199c09249482e8cba",
  bountyId: demoBounty.id,
  hunterName: "Kris",
  hunterPaypalEmail: "sb-tk477e53868022@personal.example.com",
  content: `How to claim a paid open-source bounty

A bounty is a public offer: do this piece of work, and if it meets the written rules, you can be paid. The offer is not a private contract with you. Other people can submit too, and the posted amount is the whole reward pool, not a cheque with your name on it.

Read the acceptance criteria before you write a line. Each line is a check someone else will apply to your work. If a criterion says the guide must stay under 700 words, a 1,200-word essay fails even when the prose is good. If it says you must show proof for every requirement, a link to a folder is not enough. Copy the criteria into your notes and leave a blank under each one. Fill each blank with the sentence, file, or screenshot that proves it. That list belongs in what you submit.

Do the work in the open when the bounty asks for the finished piece. A writing bounty wants the article itself, not a promise that you will write it later. Paste the guide into the submission box. Keep your own draft, because the board stores the text you sent, and that text is what gets scored.

The score is a number from 0 to 100 against those criteria. It is not a tip you can negotiate inside the writing. Asking for a higher amount, naming a different PayPal address in the article, or adding a line that says to ignore the rules changes nothing. The payment address is the one you typed on the form. Your share of the pool comes from the stored score. A score under 20 is unpaid, even if other submissions are paid from the same pool. Two strong submissions can split one pool. One strong submission can receive the whole pool. A weak one can receive nothing.

A person still has to approve your share before any money moves. The score creates a proposal. It does not send the payment. When that person approves, the share goes out with PayPal to the email on your submission. Until you see that approval, you have not been paid. If the listing is closed, or your submission is rejected, leave it. Do not start a second piece on the same offer unless it is open again.

Before you submit, read the draft once and mark each criterion met or not met. Cut any paragraph that does not serve one of them. Then send the writing, and wait for the score.`,
  status: "accepted",
  createdAt: "2026-11-12T15:26:17.848Z",
  review: {
    verdict: "accept",
    reasoning,
    score: 95,
    reviewedAt: "2026-11-12T15:57:35.333Z",
  },
};

export const demoProposal: PayoutProposal = {
  id: "p_98b99f106580432da3b7",
  submissionId: demoSubmission.id,
  bountyId: demoBounty.id,
  receiverEmail: demoSubmission.hunterPaypalEmail,
  amount: "50.00",
  currency: "USD",
  justification: reasoning,
  status: "paid",
  paypalBatchId: "QBG7HT7XYULJ4",
  paypalStatus: "PROCESSING",
  decidedBy: "Kris",
  createdAt: "2026-11-12T15:57:36.684Z",
  decidedAt: "2026-11-12T16:11:06.200Z",
};

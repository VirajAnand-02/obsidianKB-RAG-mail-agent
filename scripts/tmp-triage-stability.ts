import "dotenv/config";
import { triageEmail } from "@/lib/agents/triage";
const body =
  "how do i contact you guys ?, also is there a rate limit , i want to expand my busines and it might require a custom plan if you have that.";
for (let i = 1; i <= 4; i++) {
  const r = await triageEmail({ fromEmail: "iamtheviraj@gmail.com", subject: "", body });
  console.log(`run ${i}: ${r.classification} (${r.confidence})  q="${(r.question ?? "").slice(0, 70)}"`);
}

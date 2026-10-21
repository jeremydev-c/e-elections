import { redirect } from "next/navigation";

/** Old URL: the ballot now lives at /ballot (which sends unverified visitors to /login). */
export default function VoteRedirect() {
  redirect("/ballot");
}

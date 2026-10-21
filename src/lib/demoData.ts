/**
 * FICTIONAL demo voters for KSEF / YSK judging. They are seeded without a
 * face template, so they can vote through the *2027# USSD simulator only
 * (SIM phone number + PIN). These credentials are intentionally public.
 */
export type DemoVoter = {
  idNumber: string;
  fullName: string;
  phone: string; // +2547XXXXXXXX
  pin: string;
  wardCode: string;
  label: string; // "Rumuruti Township, Laikipia"
};

export const DEMO_VOTERS: DemoVoter[] = [
  { idNumber: "27310001", fullName: "Wanjiru Muthoni Kariuki", phone: "+254711270001", pin: "4821", wardCode: "812", label: "Rumuruti Township, Laikipia" },
  { idNumber: "27310002", fullName: "Lekishon Ole Saitoti", phone: "+254711270002", pin: "7390", wardCode: "818", label: "Tigithi, Laikipia" },
  { idNumber: "27470001", fullName: "Brian Otieno Ochieng", phone: "+254711270003", pin: "5162", wardCode: "1366", label: "Kitisuru, Nairobi" },
  { idNumber: "27470002", fullName: "Amina Hassan Abdi", phone: "+254711270004", pin: "8037", wardCode: "1371", label: "Kilimani, Nairobi" },
  { idNumber: "27010001", fullName: "Zawadi Mwanaisha Juma", phone: "+254711270005", pin: "3954", wardCode: "1", label: "Port Reitz, Mombasa" },
  { idNumber: "27010002", fullName: "Omar Salim Bakari", phone: "+254711270006", pin: "6418", wardCode: "11", label: "Bamburi, Mombasa" },
  { idNumber: "27420001", fullName: "Akinyi Atieno Odhiambo", phone: "+254711270007", pin: "2975", wardCode: "1196", label: "Railways, Kisumu" },
  { idNumber: "27420002", fullName: "Collins Omondi Onyango", phone: "+254711270008", pin: "9506", wardCode: "1186", label: "Kajulu, Kisumu" },
  { idNumber: "27270001", fullName: "Chebet Jepkosgei Rotich", phone: "+254711270009", pin: "1743", wardCode: "708", label: "Ngenyilel, Uasin Gishu" },
  { idNumber: "27270002", fullName: "Kiprono Kibet Langat", phone: "+254711270010", pin: "6289", wardCode: "701", label: "Moi's Bridge, Uasin Gishu" },
];

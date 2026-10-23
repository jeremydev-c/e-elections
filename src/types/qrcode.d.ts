// The part of the "qrcode" package this app uses (it ships without types).
declare module "qrcode" {
  const QRCode: {
    toString(
      text: string,
      options?: { type?: "svg" | "utf8" | "terminal"; errorCorrectionLevel?: "L" | "M" | "Q" | "H"; margin?: number; color?: { dark?: string; light?: string } }
    ): Promise<string>;
  };
  export default QRCode;
}

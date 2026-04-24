/*
 * ============================================================================
 * WebAudiogramReader — Teensy 4.0 + Adafruit PN532 (I2C)
 * ============================================================================
 *
 * Stateless: every valid NFC tap emits one LOGIN line with the tag's UID and
 * per-ear audiogram. No session / logout — the webapp just hot-swaps its
 * active profile whenever a new tap arrives. TAP_COOLDOWN_MS prevents a card
 * that stays on the reader from emitting continuously.
 */

#include <Wire.h>
#include <SPI.h>
#include <Adafruit_PN532.h>

#define PN532_IRQ   (2)
#define PN532_RESET (3)

Adafruit_PN532 nfc(PN532_IRQ, PN532_RESET);

constexpr uint32_t      SERIAL_BAUD     = 115200;
constexpr unsigned long TAP_COOLDOWN_MS = 1500;
constexpr unsigned long HEARTBEAT_MS    = 5000;

constexpr uint8_t N_FREQS         = 11;
constexpr uint8_t DATA_START_PAGE = 4;

constexpr size_t UID_STR_LEN = 21;

unsigned long lastTapMs       = 0;
unsigned long lastHeartbeatMs = 0;

static void uidToHex(uint8_t *uid, uint8_t uidLen, char *out, size_t outSize) {
  memset(out, 0, outSize);
  for (uint8_t i = 0; i < uidLen && (size_t)(i * 2 + 2) < outSize; i++) {
    char tmp[3];
    snprintf(tmp, sizeof(tmp), "%02X", uid[i]);
    strcat(out, tmp);
  }
}

static bool readAudiogram(int8_t *left, int8_t *right) {
  uint8_t data[24] = {0};
  for (uint8_t i = 0; i < 6; i++) {
    if (!nfc.ntag2xx_ReadPage(DATA_START_PAGE + i, &data[i * 4])) return false;
  }
  for (uint8_t i = 0; i < N_FREQS; i++) {
    left[i]  = (int8_t)data[i];
    right[i] = (int8_t)data[N_FREQS + i];
  }
  return true;
}

static void emitLogin(const char *uid, const int8_t *left, const int8_t *right) {
  Serial.print("LOGIN,");
  Serial.print(uid);
  Serial.print(",L:");
  for (uint8_t i = 0; i < N_FREQS; i++) {
    Serial.print((int)left[i]);
    if (i < N_FREQS - 1) Serial.print('/');
  }
  Serial.print(",R:");
  for (uint8_t i = 0; i < N_FREQS; i++) {
    Serial.print((int)right[i]);
    if (i < N_FREQS - 1) Serial.print('/');
  }
  Serial.println();
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  nfc.begin();
  if (!nfc.getFirmwareVersion()) {
    Serial.println("ERROR,pn532_not_responding check I2C wiring (SDA=18, SCL=19, IOREF=3.3V, 5V=Vin)");
    while (1);
  }
  nfc.SAMConfig();
  Serial.println("READY,v1");
  lastHeartbeatMs = millis();
}

void loop() {
  const unsigned long now = millis();

  if (now - lastHeartbeatMs >= HEARTBEAT_MS) {
    Serial.println("READY,v1");
    lastHeartbeatMs = now;
  }

  if (now - lastTapMs < TAP_COOLDOWN_MS) return;

  uint8_t uid[7]    = {0};
  uint8_t uidLength = 0;
  if (!nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLength, 50)) return;

  char scannedUID[UID_STR_LEN];
  uidToHex(uid, uidLength, scannedUID, sizeof(scannedUID));

  int8_t leftTh[N_FREQS];
  int8_t rightTh[N_FREQS];
  if (!readAudiogram(leftTh, rightTh)) {
    Serial.println("ERROR,read_failed");
  } else {
    emitLogin(scannedUID, leftTh, rightTh);
  }
  lastTapMs = now;
}

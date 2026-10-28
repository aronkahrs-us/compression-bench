/*
 * Compression Bench firmware
 *
 * Arduino Uno controller for a load-cell compression experiment.
 * The serial protocol is line-oriented:
 *   commands: start, stop, tare, target <kg>, base <kg>, cycles <n>, encoder
 *   samples:  DATA,time_s,mass_kg,displacement_mm,angle_deg,encoder_count,steps_missed,cycle
 *
 * Calibration values and pin assignments must be checked against the
 * assembled instrument before a measurement campaign.
 */

#include "HX711.h"
#include <Arduino.h>
#include <math.h>
 
// ======== Paramètres HX711 ========
#define LOADCELL_DOUT_PIN  6
#define LOADCELL_SCK_PIN   7
HX711 scale;
float calibration_factor = -43.895938;
 
// ======== Paramètres MT6701 Encodeur (ABZ mode) ========
#define ENC_PIN_A   2      // signal A (INT0 sur Uno)
#define ENC_PIN_B   3      // signal B (INT1 sur Uno)
#define ENC_PIN_Z   4      // signal Z (index, 1 pulse/tour)
#define ABZ_PULSES_PER_REV  800    // pulses/tour configé dans MT6701
#define COUNTS_PER_REV      (ABZ_PULSES_PER_REV * 4L)  // x4 quadrature = 800
#define COUNTS_PER_STEP     4      // 1 full step = 4 quadrature counts
 
// ======== Compteur quadrature (volatile pour ISR) ========
volatile long encoderCount = 0;
 
// ======== Boucle fermée ========
#define MAX_RETRY_PAS      3
#define SEUIL_ERREUR_CNT   2       // seuil en counts (1 pas=4 counts, tolérance ½ pas)
long  encoderCountRef     = 0;
int16_t totalStepsMissed  = 0;
int current_cycle         = 0;
 
// ======== Paramètres moteur ========
#define PAS_PAR_TOUR          200
#define VITESSE_TOUR_PAR_SEC  0.3f
int nbCycles = 55;
 
// tempo demi-impulsion (HIGH puis LOW) -> période = 2*tempo
#define TEMPO_AV  (int)(1000000.0f / (VITESSE_TOUR_PAR_SEC * PAS_PAR_TOUR * 2))
 
#define PIN_DIR  8     // Déplacé de D2 (D2 utilisé par encodeur A)
#define PIN_PUL  5
#define PIN_ENA  9     // TB6600 ENA+ (active LOW: LOW=enabled, HIGH=disabled)
#define LED_PIN  A3
 
// ======== Cibles & tolérances ========
float TARGET_KG   = 20.0;
float BASELINE_KG = 0.01;
float TOL_KG      = 0.0;
 
// ======== Contrôle programme ========
unsigned long t0      = 0;
bool stopUrgent       = false;
bool enMarche         = false;
bool debugEncoderMode = false;
 
// ======== Déplacement ========
#define MM_PAR_TOUR  1.250f
#define MM_PAR_PAS   (MM_PAR_TOUR / PAS_PAR_TOUR)
 
float deplacementActuel = 0.0;
uint8_t directionMoteur = LOW;
 
// ======== Protos ========
void surveillerCommandeSerie();
void effectuerCycles(int cycles);
long stepUntilMass(float targetKg, float tolKg, int sens, int tempo);
void faireUnPas(int tempo);
void faireUnPasClosedLoop(int tempo, int sens);
float lireAngleEncodeur();
long  lireCount();
void  resetEncodeur();
float lireMasseKg();
void logMesurePeriodic();
void debugEncodeur();
void encoderTest();
void isrEncoderA();
void isrEncoderB();
 
// ======== Buffer série (pas de String dynamique) ========
#define CMD_BUF_SIZE 20
char cmdBuf[CMD_BUF_SIZE];
uint8_t cmdIdx = 0;
 
bool lireCommandeSerie() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (cmdIdx == 0) continue;
      cmdBuf[cmdIdx] = '\0';
      for (uint8_t i = 0; i < cmdIdx; i++) {
        if (cmdBuf[i] >= 'A' && cmdBuf[i] <= 'Z') cmdBuf[i] += 32;
      }
      cmdIdx = 0;
      return true;
    }
    if (cmdIdx < CMD_BUF_SIZE - 1) {
      cmdBuf[cmdIdx++] = c;
    }
  }
  return false;
}
 
// ======== ISR quadrature x4 ========
void isrEncoderA() {
  if (digitalRead(ENC_PIN_A) == digitalRead(ENC_PIN_B))
    encoderCount++;
  else
    encoderCount--;
}
 
void isrEncoderB() {
  if (digitalRead(ENC_PIN_A) == digitalRead(ENC_PIN_B))
    encoderCount--;
  else
    encoderCount++;
}
 
// =======================================================================
void setup() {
  pinMode(PIN_DIR, OUTPUT);
  pinMode(PIN_PUL, OUTPUT);
  pinMode(PIN_ENA, OUTPUT);
  digitalWrite(PIN_ENA, HIGH);  // driver désactivé au démarrage
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
 
  Serial.begin(115200);
  while (!Serial);
 
  // Initialisation encodeur ABZ
  pinMode(ENC_PIN_A, INPUT_PULLUP);
  pinMode(ENC_PIN_B, INPUT_PULLUP);
  pinMode(ENC_PIN_Z, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(ENC_PIN_A), isrEncoderA, CHANGE);
  attachInterrupt(digitalPinToInterrupt(ENC_PIN_B), isrEncoderB, CHANGE);
  encoderCount = 0;
  totalStepsMissed = 0;
  Serial.println(F("MT6701 ABZ init (200p/rev x4=800cnt/rev)"));
  Serial.print(F("A=D2 B=D3 Z=D4 DIR=D")); Serial.println(PIN_DIR);
 
  // Initialisation HX711
  scale.begin(LOADCELL_DOUT_PIN, LOADCELL_SCK_PIN);
  scale.set_offset(7231);
  scale.set_scale(calibration_factor);
  scale.tare();
  Serial.println(F("Balance taree."));
 
  Serial.println(F("Cmds: start stop tare target <kg> base <kg> cycles <n> encoder enctest"));
  Serial.print(F("Baseline=")); Serial.print(BASELINE_KG, 3); Serial.println(F(" kg"));
}
 
// =======================================================================
void loop() {
  surveillerCommandeSerie();
 
  if (debugEncoderMode) {
    debugEncodeur();
    return;
  }
 
  if (enMarche) {
    stopUrgent = false;
    digitalWrite(PIN_ENA, LOW);   // activer driver TB6600
    delay(5);                     // laisser le driver s'initialiser
    digitalWrite(LED_PIN, HIGH);
    t0 = millis();
    deplacementActuel = 0.0;
    resetEncodeur();
    totalStepsMissed = 0;
 
    effectuerCycles(nbCycles);
 
    Serial.print(F("Total pas rattrapes: ")); Serial.println(totalStepsMissed);
    digitalWrite(PIN_ENA, HIGH);  // désactiver driver (économie courant)
    digitalWrite(LED_PIN, LOW);
    enMarche = false;
    Serial.println(F("Fin cycles. 'start' pour relancer."));
  }
}

//============================================= 

// =======================================================================
void surveillerCommandeSerie() {
  if (!lireCommandeSerie()) return;

  if (strcmp(cmdBuf, "start") == 0) {
    if (!enMarche) {
      Serial.println(F("Demarrage..."));
      enMarche = true;
    }
  } else if (strcmp(cmdBuf, "stop") == 0) {
    Serial.println(F("Arret!"));
    stopUrgent = true;
    debugEncoderMode = false;
    digitalWrite(PIN_ENA, HIGH);  // désactiver driver
  } else if (strcmp(cmdBuf, "tare") == 0) {
    scale.tare();
    Serial.println(F("Balance taree."));
  } else if (strncmp(cmdBuf, "target", 6) == 0) {
    if (cmdBuf[6] == ' ' && cmdBuf[7] != '\0') {
      TARGET_KG = atof(&cmdBuf[7]);
      Serial.print(F("Target=")); Serial.print(TARGET_KG, 2); Serial.println(F(" kg"));
    }
  } else if (strncmp(cmdBuf, "cycles", 6) == 0) {
    if (cmdBuf[6] == ' ' && cmdBuf[7] != '\0') {
      nbCycles = atoi(&cmdBuf[7]);
      Serial.print(F("Cycles=")); Serial.println(nbCycles);
    }
  } else if (strncmp(cmdBuf, "base", 4) == 0) {
    if (cmdBuf[4] == ' ' && cmdBuf[5] != '\0') {
      float val = atof(&cmdBuf[5]);
      if (val < 0) val = 0;
      BASELINE_KG = val;
      Serial.print(F("Baseline=")); Serial.print(BASELINE_KG, 3); Serial.println(F(" kg"));
    }
  } else if (strcmp(cmdBuf, "encoder") == 0 || strcmp(cmdBuf, "debug") == 0) {
    if (!enMarche) {
      debugEncoderMode = true;
      Serial.println(F("=== DEBUT DEBUG ENCODEUR ==="));
    }
  } else if (strcmp(cmdBuf, "enctest") == 0) {
    if (!enMarche) encoderTest();
  }
}
 
// =======================================================================
// Cycle: compression jusqu'à TARGET_KG, puis retour à BASELINE_KG (par masse)
void effectuerCycles(int cycles) {
  for (current_cycle = 0; current_cycle < cycles; current_cycle++) {
    if (stopUrgent) return;
 
    Serial.print(F("Cycle ")); Serial.println(current_cycle + 1);
 
    Serial.print(F("Comp->")); Serial.print(TARGET_KG, 1); Serial.println(F("kg"));
    long stepsCompression = stepUntilMass(TARGET_KG, TOL_KG, LOW, TEMPO_AV);
    if (stopUrgent) return;
    Serial.print(F("OK ")); Serial.print(stepsCompression); Serial.println(F(" pas"));
 
    delay(100);
 
    Serial.print(F("Decomp->")); Serial.print(BASELINE_KG, 3); Serial.println(F("kg"));
    long stepsDecomp = stepUntilMass(BASELINE_KG, TOL_KG, HIGH, TEMPO_AV);
    if (stopUrgent) return;
    Serial.print(F("OK ")); Serial.print(stepsDecomp); Serial.println(F(" pas"));
 
    delay(100);
  }
}
 
// =======================================================================
// Avance pas à pas jusqu'à targetKg (± tolKg) dans le sens 'sens' (LOW=comp, HIGH=decomp)
// AUCUNE LIMITE de pas : on avance jusqu'à atteindre la masse demandée.
long stepUntilMass(float targetKg, float tolKg, int sens, int tempo) {
  digitalWrite(PIN_DIR, sens);
  directionMoteur = sens;
 
  long steps = 0;
  unsigned long lastMesureTime = millis();
 
  while (!stopUrgent) {
    // 1 pas en boucle fermée
    faireUnPasClosedLoop(tempo, sens);
 
    if (sens == LOW) {
      deplacementActuel += MM_PAR_PAS;
    } else {
      deplacementActuel -= MM_PAR_PAS;
    }
 
    steps++;
 
    // Lecture périodique & décision d'arrêt
    if (millis() - lastMesureTime >= 100) {
      lastMesureTime = millis();
      float m = lireMasseKg();
      float angle = lireAngleEncodeur();
      long cnt = lireCount();
      float tsec = (millis() - t0) / 1000.0;

      // Single structured string for Python parsing
      Serial.print(F("DATA,"));
      Serial.print(tsec, 2);                Serial.print(F(","));
      Serial.print(m, 3);                   Serial.print(F(","));
      Serial.print(deplacementActuel, 2);  Serial.print(F(","));
      Serial.print(angle, 1);               Serial.print(F(","));
      Serial.print(cnt);                    Serial.print(F(","));
      Serial.print(totalStepsMissed);       Serial.print(F(","));
      Serial.println(current_cycle + 1);

      if (sens == LOW) {
        if (m >= (targetKg - tolKg)) break;
      } else {
        if (m <= (targetKg + tolKg)) break;
      }
    }
 
    surveillerCommandeSerie();
  }
 
  return steps;
}
 
// =======================================================================
void faireUnPas(int tempo) {
  digitalWrite(PIN_PUL, HIGH);
  delayMicroseconds(tempo);
  digitalWrite(PIN_PUL, LOW);
  delayMicroseconds(tempo);
}
 
// =======================================================================
// Lecture thread-safe du compteur quadrature
long lireCount() {
  long cnt;
  noInterrupts();
  cnt = encoderCount;
  interrupts();
  return cnt;
}
 
// =======================================================================
// Angle continu depuis le compteur quadrature
float lireAngleEncodeur() {
  return (lireCount() * 360.0f) / (float)COUNTS_PER_REV;
}
 
// =======================================================================
void resetEncodeur() {
  noInterrupts();
  encoderCount = 0;
  interrupts();
  encoderCountRef = 0;
}
 
// =======================================================================
// Fait un pas moteur avec vérification encodeur ABZ et rattrapage
void faireUnPasClosedLoop(int tempo, int sens) {
  long cntAvant = lireCount();
  long deltaCible = (sens == LOW) ? COUNTS_PER_STEP : -COUNTS_PER_STEP;
  long cntCible = cntAvant + deltaCible;

  faireUnPas(tempo);
  delayMicroseconds(300); // Allow rotor to settle physically before reading encoder

  long cntApres = lireCount();
  long erreur = cntCible - cntApres;

  int retries = 0;
  while (abs(erreur) > SEUIL_ERREUR_CNT && retries < MAX_RETRY_PAS) {
    retries++;
    totalStepsMissed++;

    faireUnPas(tempo);
    delayMicroseconds(300); // Allow settling on retries

    cntApres = lireCount();
    erreur = cntCible - cntApres;
  }

  if (retries >= MAX_RETRY_PAS && abs(erreur) > SEUIL_ERREUR_CNT) {
    Serial.print(F("[CL]FAIL e=")); Serial.print(erreur); Serial.println(F("cnt"));
  }
}
// =======================================================================
float lireMasseKg() {
  //scale.set_scale(calibration_factor);
  float massekg = fabs(scale.get_units(1));
  massekg = massekg / 1000.0f;
  if (!isfinite(massekg)) massekg = 0.0;
  if (massekg < 0) massekg = 0.0;
  return massekg;
}
 
// =======================================================================
void logMesurePeriodic() {
  static unsigned long lastLog = 0;
  if (millis() - lastLog >= 100) {
    lastLog = millis();
    float m = lireMasseKg();
    float angle = lireAngleEncodeur();
    float tsec = (millis() - t0) / 1000.0;
    Serial.print(tsec, 2);   Serial.print(F("s "));
    Serial.print(m, 3);      Serial.print(F("kg "));
    Serial.print(deplacementActuel, 2); Serial.print(F("mm "));
    Serial.print(angle, 1);  Serial.print(F("deg R"));
    Serial.println(totalStepsMissed);  Serial.print(F("missed_step"));
    Serial.println(current_cycle);  Serial.print(F("current_cycle"));
  }
}
 
// =======================================================================
// Mode debug encodeur : affichage continu count + angle
void debugEncodeur() {
  static unsigned long lastPrint = 0;
 
  if (lireCommandeSerie()) {
    if (strcmp(cmdBuf, "stop") == 0 || strcmp(cmdBuf, "quit") == 0) {
      debugEncoderMode = false;
      Serial.println(F("=== FIN DEBUG ==="));
      return;
    }
    if (strcmp(cmdBuf, "reset") == 0) {
      resetEncodeur();
      Serial.println(F("Encodeur reset."));
    }
  }
 
  if (millis() - lastPrint >= 200) {
    lastPrint = millis();
    long cnt = lireCount();
    float angle = lireAngleEncodeur();
 
    Serial.print(F("Cnt=")); Serial.print(cnt);
    Serial.print(F(" Ang=")); Serial.print(angle, 2);
    Serial.print(F(" T=")); Serial.print(angle / 360.0, 3);
    Serial.print(F(" A=")); Serial.print(digitalRead(ENC_PIN_A));
    Serial.print(F(" B=")); Serial.println(digitalRead(ENC_PIN_B));
  }
}
 
// =======================================================================
// Test encodeur : tourner l'arbre 3s et observer les counts
void encoderTest() {
  Serial.println(F("=== ENC TEST (ABZ) ==="));
  Serial.print(F("A=D")); Serial.print(ENC_PIN_A);
  Serial.print(F(" B=D")); Serial.print(ENC_PIN_B);
  Serial.print(F(" Z=D")); Serial.println(ENC_PIN_Z);
  Serial.println(F("Tourner l'arbre..."));
 
  resetEncodeur();
  unsigned long start = millis();
  while (millis() - start < 3000) {
    long cnt = lireCount();
    float angle = lireAngleEncodeur();
    Serial.print(F("Cnt=")); Serial.print(cnt);
    Serial.print(F(" Ang=")); Serial.print(angle, 2);
    Serial.println(F("deg"));
    delay(200);
    if (lireCommandeSerie() && strcmp(cmdBuf, "stop") == 0) break;
  }
 
  long finalCnt = lireCount();
  if (finalCnt == 0) {
    Serial.println(F("ATTENTION: count=0. Verifier cablage A/B."));
  } else {
    Serial.print(F("OK: ")); Serial.print(finalCnt); Serial.println(F(" counts"));
  }
  Serial.println(F("=== FIN ==="));
}

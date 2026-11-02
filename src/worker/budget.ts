import type { Env } from './env';

// Cloudflare corta cada corrida (del cron o de un botón) que hace más de 50 consultas a otros servicios en el plan
// gratuito («Too many subrequests»). Las sincronizaciones con ClickUp y Finnegans cuentan las suyas y frenan antes;
// lo que falta sigue en la corrida siguiente. Con el plan pago se puede subir con la variable SUBREQUESTS.
export class Budget {
  used = 0;
  constructor(public max: number) {}
  static of(env: Env) { return new Budget(Number(env.SUBREQUESTS) || 45); }
  left() { return this.max - this.used; }
  take() {
    if (this.used >= this.max) throw new OutOfBudget();
    this.used++;
  }
}

export class OutOfBudget extends Error {
  constructor() { super('Se llegó al tope de consultas de esta corrida; sigue en la próxima.'); }
}

// server.js
// Bestell-Backend für Pizzeria Ristorante Pinocchio.
//
// Was dieser Server macht:
//  1. Nimmt Bestellungen von der Website entgegen (POST /api/orders)
//  2. Erstellt bei Karte/PayPal eine sichere Stripe-Checkout-Seite
//     (ihr fasst NIE echte Kartendaten an – das übernimmt Stripe)
//  3. Bekommt von Stripe eine Bestätigung, sobald bezahlt wurde (Webhook)
//  4. Schickt die Bestellung dann automatisch an den Küchendrucker (PrintNode)
//
// Bei Barzahlung wird sofort gedruckt, ohne Umweg über Stripe.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');
const { printOrder } = require('./printer');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const DELIVERY_FEE = 2.0; // € – muss zum Wert auf der Website passen
const MIN_ORDER_DELIVERY = 15.0; // € – Mindestbestellwert für Lieferung
const WEBSITE_DISCOUNT_RATE = 0.10; // 10% Rabatt exklusiv für Online-Bestellungen — muss zum Frontend passen

// ---------------------------------------------------------------------
// Server-seitiger Preiskatalog. NIE den vom Kunden mitgeschickten Preis
// vertrauen — sonst könnte jemand über die Browser-Konsole oder curl
// eigene Preise einreichen. Schlüssel: "<kategorie>::<nummer-oder-name>",
// exakt wie im Frontend (menuData) aufgebaut. Bei Änderungen an der
// Speisekarte muss menu-catalog.json mit aktualisiert werden.
// ---------------------------------------------------------------------
const MENU_CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'menu-catalog.json'), 'utf8'));

// Extra-Zutaten (z.B. "Extra Käse") — muss exakt zum EXTRAS-Array im
// Frontend (site2.html) passen, inkl. der IDs.
const EXTRAS_CATALOG = {
  kaese: { label: 'Extra Käse', price: 1.50 },
  schinken: { label: 'Extra Schinken', price: 2.00 },
  peperoni: { label: 'Extra Peperoni', price: 1.50 },
  oliven: { label: 'Extra Oliven', price: 1.00 },
};

// ---------------------------------------------------------------------
// Datenhaltung: Bestellungen werden bei Upstash Redis gespeichert — ein
// kostenloser Cloud-Speicher, der (anders als Render's lokales Dateisystem)
// einen Redeploy übersteht. Kein Persistent-Disk-Abo nötig.
//
// Einrichtung (siehe README): kostenloses Konto bei upstash.com, dort eine
// "Redis"-Datenbank anlegen, REST-URL und REST-Token in die Render-
// Umgebungsvariablen UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
// eintragen.
//
// Ohne diese beiden Variablen fällt der Server automatisch auf eine lokale
// Datei zurück (praktisch zum Testen auf dem eigenen Rechner) — dann gilt
// aber wieder: Bestellungen überleben keinen Redeploy bei Render.
// ---------------------------------------------------------------------
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ORDERS_KEY = 'pinocchio:orders';

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'orders.json');

async function loadOrders() {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const res = await fetch(`${UPSTASH_URL}/get/${ORDERS_KEY}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      });
      const data = await res.json();
      if (!res.ok) {
        console.error('[upstash] Fehler beim Laden:', res.status, JSON.stringify(data));
        return {};
      }
      if (!data.result) return {};
      let parsed = JSON.parse(data.result);
      // Selbstreparatur: durch einen früheren Bug wurden Bestellungen
      // teils doppelt kodiert gespeichert (ein String statt eines
      // Objekts). Erkennen wir das, verwerfen wir die kaputten Altdaten
      // automatisch, statt mit falschen Daten weiterzuarbeiten.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        console.warn('[upstash] Kaputte Altdaten erkannt (vermutlich vom Doppel-Encoding-Bug) — setze auf leeren Bestellverlauf zurück.');
        return {};
      }
      return parsed;
    } catch (err) {
      console.error('[upstash] Ausnahme beim Laden:', err.message);
      return {};
    }
  }
  // Lokaler Fallback (nur fürs Testen auf dem eigenen Rechner)
  if (!fs.existsSync(DB_FILE)) return {};
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8') || '{}');
}

async function saveOrders(orders) {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const res = await fetch(`${UPSTASH_URL}/set/${ORDERS_KEY}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
        body: JSON.stringify(orders),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error('[upstash] Fehler beim Speichern:', res.status, JSON.stringify(data));
      }
    } catch (err) {
      console.error('[upstash] Ausnahme beim Speichern:', err.message);
    }
    return;
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2));
}

async function nextOrderNumber() {
  const orders = await loadOrders();
  const count = Object.keys(orders).length + 1;
  const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  return `PIN-${datePart}-${String(count).padStart(3, '0')}`;
}

// Hängt ?order=...&status=... an eine Basis-URL an (egal ob die schon
// andere Query-Parameter hat oder nicht).
function appendOrderParams(baseUrl, orderNumber, status) {
  const url = baseUrl || ALLOWED_ORIGIN + '/';
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}order=${encodeURIComponent(orderNumber)}&status=${status}`;
}

// Holt den wiederverwendbaren 10%-Website-Rabattcode bei Stripe, legt ihn
// beim allerersten Mal an, falls er noch nicht existiert.
let cachedCouponId = null;
async function getWebsiteDiscountCouponId() {
  if (cachedCouponId) return cachedCouponId;
  const couponId = 'WEBSITE10';
  try {
    await stripe.coupons.retrieve(couponId);
  } catch (err) {
    await stripe.coupons.create({
      id: couponId,
      percent_off: WEBSITE_DISCOUNT_RATE * 100,
      duration: 'once',
      name: 'Website-Rabatt 10%',
    });
  }
  cachedCouponId = couponId;
  return couponId;
}

// ---------------------------------------------------------------------
// Der Status-Kreislauf einer Bestellung, in der Reihenfolge wie sie
// durchlaufen wird. "pending" (Zahlung offen) ist ein Sonderfall davor.
// ---------------------------------------------------------------------
const STATUS_FLOW = ['received', 'preparing', 'ready', 'completed'];
const STATUS_LABELS = {
  pending: 'Zahlung ausstehend',
  received: 'Bestellung eingegangen',
  preparing: 'Wird zubereitet',
  ready: 'Fertig',
  completed: 'Abgeschlossen',
  cancelled: 'Storniert',
};

// ---------------------------------------------------------------------
// WICHTIG: Die Stripe-Webhook-Route braucht den rohen Request-Body
// (nicht als JSON geparst) um die Signatur zu prüfen. Deshalb wird sie
// VOR express.json() registriert und bekommt ihren eigenen Parser.
// ---------------------------------------------------------------------
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] Signatur ungültig:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderNumber = session.metadata && session.metadata.orderNumber;
    if (orderNumber) {
      const orders = await loadOrders();
      const order = orders[orderNumber];
      if (order && order.status !== 'received') {
        order.status = 'received';
        order.paidAt = new Date().toISOString();
        order.statusHistory = [{ status: 'received', at: order.paidAt }];
        await saveOrders(orders);
        try {
          await printOrder(order);
          console.log(`[order] ${orderNumber} bezahlt & gedruckt.`);
        } catch (err) {
          // Zahlung war erfolgreich – ein Druckerfehler darf die Bestellung
          // NICHT verschwinden lassen. Stattdessen laut im Log meckern,
          // damit ihr es merkt und den Bon notfalls manuell ausdruckt.
          console.error(`[order] ${orderNumber} bezahlt, aber Druck fehlgeschlagen:`, err.message);
        }
      }
    }
  }

  res.json({ received: true });
});

// Ab hier normaler JSON-Body-Parser für alle anderen Routen
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

// -----------------------------------------------------------------
// POST /api/orders – wird von der Website beim Checkout aufgerufen
// -----------------------------------------------------------------
app.post('/api/orders', async (req, res) => {
  try {
    const { items, type, address, name, phone, email, note, payment, successUrl, cancelUrl, acceptedTerms } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Warenkorb ist leer.' });
    }
    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'Name fehlt.' });
    }
    if (type === 'lieferung' && (!address || address.trim().length < 6)) {
      return res.status(400).json({ error: 'Lieferadresse fehlt.' });
    }
    if (!acceptedTerms) {
      return res.status(400).json({ error: 'Bitte AGB und Widerrufsbelehrung akzeptieren.' });
    }

    // ---------------------------------------------------------------
    // SICHERHEIT: Jeder Artikel wird gegen den Server-Katalog geprüft.
    // Wir übernehmen NIE den vom Client gesendeten Preis — Name, Menge
    // und die Katalog-Referenz (category::key) kommen vom Client, der
    // tatsächliche Preis kommt ausschließlich aus MENU_CATALOG.
    // Unbekannte Artikel oder fehlende Referenzen -> Bestellung abgelehnt.
    // ---------------------------------------------------------------
    const validatedItems = [];
    for (const it of items) {
      if (!it || typeof it.catalogKey !== 'string' || !MENU_CATALOG[it.catalogKey]) {
        return res.status(400).json({ error: `Unbekannter Artikel in der Bestellung: "${it && it.name}". Bitte Seite neu laden und erneut versuchen.` });
      }
      const qty = Number(it.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
        return res.status(400).json({ error: `Ungültige Menge für "${it.name}".` });
      }
      const catalogEntry = MENU_CATALOG[it.catalogKey];
      let itemPrice = catalogEntry.price;
      let itemName = catalogEntry.name;

      // Extra-Zutaten (z.B. Extra Käse) — Preis kommt ausschließlich aus
      // EXTRAS_CATALOG, nie vom Client. Unbekannte Extras -> ablehnen.
      if (Array.isArray(it.extras) && it.extras.length > 0) {
        const extraLabels = [];
        for (const extraId of it.extras) {
          if (!EXTRAS_CATALOG[extraId]) {
            return res.status(400).json({ error: `Unbekannte Extra-Zutat: "${extraId}".` });
          }
          itemPrice += EXTRAS_CATALOG[extraId].price;
          extraLabels.push(EXTRAS_CATALOG[extraId].label);
        }
        itemName = `${itemName} (${extraLabels.join(', ')})`;
      }

      validatedItems.push({ name: itemName, price: itemPrice, qty });
    }

    const subtotal = validatedItems.reduce((s, it) => s + it.price * it.qty, 0);
    if (type === 'lieferung' && subtotal < MIN_ORDER_DELIVERY) {
      return res.status(400).json({ error: `Mindestbestellwert für Lieferung sind ${MIN_ORDER_DELIVERY.toFixed(2).replace('.', ',')} €.` });
    }
    const deliveryFee = type === 'lieferung' ? DELIVERY_FEE : 0;
    const preDiscountTotal = subtotal + deliveryFee;
    const discount = Math.round(preDiscountTotal * WEBSITE_DISCOUNT_RATE * 100) / 100;
    const total = preDiscountTotal - discount;
    const orderNumber = await nextOrderNumber();

    const order = {
      orderNumber,
      items: validatedItems,
      type,
      address: address || null,
      name,
      phone: phone || null,
      email: email || null,
      note: note || null,
      payment,
      subtotal,
      deliveryFee,
      discount,
      total,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    const orders = await loadOrders();
    orders[orderNumber] = order;
    await saveOrders(orders);

    // Barzahlung: kein Stripe nötig – direkt bestätigen & drucken.
    if (payment === 'bar') {
      order.status = 'received';
      order.statusHistory = [{ status: 'received', at: new Date().toISOString() }];
      orders[orderNumber] = order;
      await saveOrders(orders);
      try {
        await printOrder(order);
      } catch (err) {
        console.error(`[order] ${orderNumber} (bar) Druck fehlgeschlagen:`, err.message);
      }
      return res.json({ orderNumber, status: 'received' });
    }

    // Karte / PayPal: Stripe-Checkout-Session erzeugen.
    // Stripe Checkout bietet in einer einzigen Session sowohl Kartenzahlung
    // als auch PayPal an (sofern PayPal in eurem Stripe-Konto aktiviert ist).
    const line_items = validatedItems.map(it => ({
      price_data: {
        currency: 'eur',
        product_data: { name: it.name },
        unit_amount: Math.round(it.price * 100),
      },
      quantity: it.qty,
    }));
    if (deliveryFee > 0) {
      line_items.push({
        price_data: {
          currency: 'eur',
          product_data: { name: 'Liefergebühr' },
          unit_amount: Math.round(deliveryFee * 100),
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'paypal'],
      line_items,
      discounts: [{ coupon: await getWebsiteDiscountCouponId() }],
      metadata: { orderNumber },
      success_url: appendOrderParams(successUrl, orderNumber, 'success'),
      cancel_url: appendOrderParams(cancelUrl, orderNumber, 'cancelled'),
    }, {
      idempotencyKey: `order-${orderNumber}`,
    });

    res.json({ orderNumber, checkoutUrl: session.url });
  } catch (err) {
    console.error('[order] Fehler beim Anlegen der Bestellung:', err);
    res.status(500).json({ error: 'Interner Fehler beim Anlegen der Bestellung.' });
  }
});

// -----------------------------------------------------------------
// GET /api/orders/:orderNumber – öffentliche Bestellverfolgung für Kunden.
// Bewusst NUR die Infos, die man zur Verfolgung braucht — keine
// Telefonnummer/E-Mail/genaue Adresse, falls die Nummer mal weitergegeben wird.
// -----------------------------------------------------------------
app.get('/api/orders/:orderNumber', async (req, res) => {
  // Nie zwischenspeichern lassen — diese Antwort ändert sich mit dem
  // Bestellstatus, ein gecachter 304 würde sonst fälschlich wie ein
  // Serverfehler aussehen (siehe fetch() im Frontend).
  res.set('Cache-Control', 'no-store');
  const orders = await loadOrders();
  const order = orders[req.params.orderNumber];
  if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden.' });
  res.json({
    orderNumber: order.orderNumber,
    status: order.status,
    statusLabel: STATUS_LABELS[order.status] || order.status,
    statusHistory: order.statusHistory || [],
    type: order.type,
    items: order.items,
    total: order.total,
    createdAt: order.createdAt,
  });
});

// -----------------------------------------------------------------
// PATCH /api/admin/orders/:orderNumber – Status ändern (nur Personal).
// Wird von admin.html benutzt, um eine Bestellung durch die Stufen
// "Wird zubereitet" -> "Fertig" -> "Abgeschlossen" zu schieben.
// -----------------------------------------------------------------
app.patch('/api/admin/orders/:orderNumber', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Falscher oder fehlender Schlüssel.' });
  }
  const { status } = req.body;
  const validStatuses = [...STATUS_FLOW, 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Ungültiger Status.' });
  }
  const orders = await loadOrders();
  const order = orders[req.params.orderNumber];
  if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden.' });

  order.status = status;
  order.statusHistory = order.statusHistory || [];
  order.statusHistory.push({ status, at: new Date().toISOString() });
  await saveOrders(orders);
  res.json({ orderNumber: order.orderNumber, status: order.status });
});

// -----------------------------------------------------------------
// GET /api/admin/orders?key=... – Bestellübersicht für den Inhaber.
// Geschützt durch einen einfachen geheimen Schlüssel (ADMIN_KEY in .env),
// damit nicht jeder eure Bestellungen einsehen kann.
// -----------------------------------------------------------------
app.get('/api/admin/orders', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Falscher oder fehlender Schlüssel.' });
  }
  const orders = await loadOrders();
  // neueste zuerst
  const list = Object.values(orders).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders: list });
});

// -----------------------------------------------------------------
// GET /api/admin/report?from=YYYY-MM-DD&to=YYYY-MM-DD&key=...
// Berichte fürs Finanzamt / den Tagesabschluss: Z-Bericht (ein Tag) oder
// Jahresbericht (ganzes Jahr) — einfach über den Datumsbereich steuerbar.
// Nur abgeschlossene (nicht 'pending' oder 'cancelled') Bestellungen
// zählen zum Umsatz.
// -----------------------------------------------------------------
app.get('/api/admin/report', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Falscher oder fehlender Schlüssel.' });
  }
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'Bitte "from" und "to" als YYYY-MM-DD angeben.' });
  }
  const fromDate = new Date(from + 'T00:00:00');
  const toDate = new Date(to + 'T23:59:59.999');

  const orders = await loadOrders();
  const inRange = Object.values(orders).filter(o => {
    const created = new Date(o.createdAt);
    return created >= fromDate && created <= toDate;
  });

  const counted = inRange.filter(o => !['pending', 'cancelled'].includes(o.status));
  const cancelled = inRange.filter(o => o.status === 'cancelled');

  const revenue = counted.reduce((s, o) => s + o.total, 0);
  const revenueByPayment = {};
  const revenueByType = {};
  let totalDiscount = 0;
  let totalDeliveryFees = 0;

  counted.forEach(o => {
    revenueByPayment[o.payment] = (revenueByPayment[o.payment] || 0) + o.total;
    revenueByType[o.type] = (revenueByType[o.type] || 0) + o.total;
    totalDiscount += o.discount || 0;
    totalDeliveryFees += o.deliveryFee || 0;
  });

  res.json({
    from, to,
    orderCount: counted.length,
    cancelledCount: cancelled.length,
    revenue: Math.round(revenue * 100) / 100,
    revenueByPayment,
    revenueByType,
    totalDiscount: Math.round(totalDiscount * 100) / 100,
    totalDeliveryFees: Math.round(totalDeliveryFees * 100) / 100,
    orders: counted.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
  });
});

// -----------------------------------------------------------------
// POST /api/admin/orders/:orderNumber/reprint – manueller Nachdruck.
// Für den Fall, dass der automatische Druck fehlgeschlagen ist (Drucker
// offline, PrintNode nicht erreichbar) — Personal kann so ohne
// Server-Zugriff einen Bon erneut anstoßen.
// -----------------------------------------------------------------
app.post('/api/admin/orders/:orderNumber/reprint', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Falscher oder fehlender Schlüssel.' });
  }
  const orders = await loadOrders();
  const order = orders[req.params.orderNumber];
  if (!order) return res.status(404).json({ error: 'Bestellung nicht gefunden.' });

  try {
    const result = await printOrder(order);
    if (result && result.skipped) {
      return res.status(400).json({ error: 'PrintNode ist nicht konfiguriert (PRINTNODE_API_KEY/PRINTNODE_PRINTER_ID fehlen).' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Nachdruck fehlgeschlagen: ${err.message}` });
  }
});

app.get('/', (req, res) => {
  res.send('Pinocchio-Bestellserver läuft. ✅');
});

// -----------------------------------------------------------------
// GET /api/admin/debug-storage?key=... – Diagnose: testet direkt, ob
// die Verbindung zu Upstash funktioniert (Schreiben + Lesen eines
// Test-Werts), unabhängig vom eigentlichen Bestellvorgang.
// -----------------------------------------------------------------
app.get('/api/admin/debug-storage', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Falscher oder fehlender Schlüssel.' });
  }
  const configured = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
  if (!configured) {
    return res.json({ configured: false, message: 'UPSTASH_REDIS_REST_URL oder UPSTASH_REDIS_REST_TOKEN fehlt in den Umgebungsvariablen.' });
  }
  try {
    const testKey = 'pinocchio:debug-test';
    const testValue = `test-${Date.now()}`;
    const setRes = await fetch(`${UPSTASH_URL}/set/${testKey}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      body: testValue,
    });
    const setData = await setRes.json();
    const getRes = await fetch(`${UPSTASH_URL}/get/${testKey}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const getData = await getRes.json();
    const roundTripOk = getData.result === testValue;

    const orders = await loadOrders();

    res.json({
      configured: true,
      setStatus: setRes.status,
      setResponse: setData,
      getStatus: getRes.status,
      getResponse: getData,
      roundTripOk,
      currentOrderCount: Object.keys(orders).length,
    });
  } catch (err) {
    res.status(500).json({ configured: true, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Pinocchio-Backend läuft auf Port ${PORT}`);
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.warn('⚠️  UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN sind nicht gesetzt! Bestellungen werden NICHT dauerhaft gespeichert und gehen beim nächsten Redeploy verloren. Siehe README.');
  }
});

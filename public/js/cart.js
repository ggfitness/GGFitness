// Lógica de carrito compartida (guardada en localStorage del navegador).
const Cart = {
  KEY: 'pt_cart',

  get() {
    try { return JSON.parse(localStorage.getItem(this.KEY)) || []; }
    catch { return []; }
  },
  save(items) {
    localStorage.setItem(this.KEY, JSON.stringify(items));
    this.updateBadge();
  },
  add(product) {
    // Los planes que se coordinan por WhatsApp no entran al carrito: el
    // servidor los rechaza igual, mejor no dejar que llegue hasta ahí.
    if (product.soloConsulta) return false;
    const items = this.get();
    const found = items.find((i) => i.id === product.id);
    if (found) found.qty += 1;
    else items.push({ id: product.id, name: product.name, price: product.price, image: product.image, qty: 1 });
    this.save(items);
    return true;
  },
  setQty(id, qty) {
    let items = this.get();
    if (qty <= 0) items = items.filter((i) => i.id !== id);
    else items = items.map((i) => (i.id === id ? { ...i, qty } : i));
    this.save(items);
  },
  remove(id) {
    this.save(this.get().filter((i) => i.id !== id));
  },
  clear() { this.save([]); },
  count() { return this.get().reduce((s, i) => s + i.qty, 0); },
  total() { return this.get().reduce((s, i) => s + i.price * i.qty, 0); },

  updateBadge() {
    const el = document.querySelector('.cart-count');
    if (el) {
      const c = this.count();
      el.textContent = c;
      el.style.display = c > 0 ? 'flex' : 'none';
    }
  },
};

const money = (n) => '$' + Number(n).toLocaleString('es-AR');

// La validación del email (validEmail / emailProblem / emailHint) vive en
// /js/email.js, que es EL MISMO archivo que usa el servidor. Cargalo antes que
// este script en cualquier página que valide un formulario.

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(window.__toastT);
  window.__toastT = setTimeout(() => t.classList.remove('show'), 2200);
}

document.addEventListener('DOMContentLoaded', () => Cart.updateBadge());

// Renderiza la grilla de planes/productos (usado en la landing y en /productos.html).
// - Toda la tarjeta es clickeable y lleva al detalle del producto.
// - El botón "Comprar" agrega al carrito sin salir de la página.
// Formatea el precio según moneda (ARS/USD) y período (ej: /mes)
function formatPrice(p) {
  const amount = Number(p.price).toLocaleString('es-AR');
  const main = p.currency === 'USD' ? `US$ ${amount}` : `$${amount}`;
  const unit = p.period ? `/${p.period}` : (p.currency === 'USD' ? 'USD' : 'ARS');
  return `${main} <small>${unit}</small>`;
}

// En los packs, el nombre entero va en mayuscula: "PACK" en blanco y el resto
// en rosa. Los productos que no arrancan con "Pack" se muestran tal cual.
function formatName(name) {
  const m = /^(Pack)\s+(.+)$/i.exec(name);
  return m
    ? `<span class="pack-name">${m[1]} <span class="name-hl">${m[2]}</span></span>`
    : name;
}

function renderProducts(products, grid) {
  if (!products || !products.length) {
    grid.innerHTML = '<p class="empty">Pronto vas a ver los planes acá.</p>';
    return;
  }
  const featuredIdx = products.length >= 3 ? 1 : 0;

  grid.innerHTML = products.map((p, i) => {
    const url = '/producto.html?id=' + encodeURIComponent(p.id);
    const thumb = p.photo
      ? `<img src="${p.photo}" alt="${p.name}" loading="lazy" />`
      : (p.image || '🏋️');
    const note = p.soloConsulta
      ? 'Coordinás todo por WhatsApp'
      : (p.period ? `Se renueva cada ${p.period}` : 'Pago único · Acceso inmediato');
    // Los personalizados no se cobran por la web: se arranca hablando con la
    // trainer, que después coordina el pago.
    const cta = p.soloConsulta
      ? ''
      : `<button class="btn btn-sm" data-id="${p.id}">Comprar →</button>`;
    const wa = p.whatsappUrl
      ? `<a class="btn btn-wa btn-sm" href="${p.whatsappUrl}" target="_blank" rel="noopener">Consultar por WhatsApp</a>`
      : '';
    return `
      <div class="product ${i === featuredIdx ? 'featured' : ''}" data-href="${url}">
        ${i === featuredIdx ? '<span class="badge-top">⭐ Más elegido</span>' : ''}
        <a class="thumb thumb-link" href="${url}">${thumb}</a>
        <div class="body">
          <h3>${formatName(p.name)}</h3>
          <p class="desc">${p.tagline || p.description || ''}</p>
          <div class="price">${formatPrice(p)}</div>
          <div class="price-note">${note}</div>
          ${p.comboMaxOff ? `<a class="combo-hint" href="#combos">◆ Combinable</a>` : ''}
          <div class="product-actions">
            <a class="btn btn-ghost btn-sm" href="${url}">Ver detalle</a>
            ${cta}
            ${wa}
          </div>
        </div>
      </div>`;
  }).join('');

  // Botón "Comprar": agrega al carrito (sin navegar)
  grid.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = products.find((x) => x.id === btn.dataset.id);
      Cart.add(p);
      toast(`✅ "${p.name}" agregado al carrito`);
    });
  });

  // Click en la tarjeta (fuera de botones/links): va al detalle
  grid.querySelectorAll('.product[data-href]').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('a')) return;
      window.location.href = card.dataset.href;
    });
  });
}

// Renderiza las promos por combo. Los importes (subtotal/descuento/total) vienen
// ya calculados por el servidor con el mismo motor que el checkout, así que acá
// no se recalcula nada: solo se muestra.
function renderCombos(rules, el, products) {
  if (!el) return;
  const section = el.closest('section');
  if (!rules || !rules.length) {
    if (section) section.style.display = 'none'; // sin promos, no mostramos la sección vacía
    return;
  }
  const byId = Object.fromEntries((products || []).map((p) => [p.id, p]));

  el.innerHTML = rules
    .map((r) => {
      const items = r.products
        .map((x) => `<li><span class="check">✓</span><span>${x.name}</span></li>`)
        .join('');
      return `
        <div class="combo">
          <ul class="check-list combo-list">${items}</ul>
          <div class="combo-prices">
            <span class="was">${money(r.subtotal)}</span>
            <span class="now">${money(r.total)}</span>
          </div>
          <div class="combo-save">Ahorrás ${money(r.discount)}</div>
          <button class="btn btn-sm btn-block" data-combo="${r.id}">Agregar los ${r.products.length} →</button>
        </div>`;
    })
    .join('');

  el.querySelectorAll('button[data-combo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rule = rules.find((r) => r.id === btn.dataset.combo);
      if (!rule) return;
      // Solo sumamos lo que falta: si vuelve a hacer click no duplica cantidades
      // (el descuento se calcula sobre UNA unidad de cada producto).
      const inCart = new Set(Cart.get().map((i) => i.id));
      let sumados = 0;
      rule.products.forEach((x) => {
        if (inCart.has(x.id) || !byId[x.id]) return;
        Cart.add(byId[x.id]);
        sumados++;
      });
      toast(
        sumados
          ? `✅ ${sumados} pack${sumados > 1 ? 's' : ''} agregado${sumados > 1 ? 's' : ''} · promo aplicada`
          : 'Ya tenés todos los packs de esta promo en el carrito'
      );
    });
  });
}

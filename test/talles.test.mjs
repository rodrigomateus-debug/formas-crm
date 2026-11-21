// Talles (src/worker/talles.ts): el talle de cada producto y cuáles van juntos, con SKU y nombres reales (catálogo textil de
// formas.shop y pedidos del 20/11/2026). No necesita el CRM corriendo: prueba las reglas solas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agruparTalles, costoLogoDeGrupo, raizComun, talleCanonico, talleDeNombre, talleDeSku } from '../src/worker/talles.ts';
import { productosParaElegir } from '../web/src/talles.ts';

const talle = (s) => talleDeNombre(s)?.talle.talle ?? null;
const grupos = (items) => agruparTalles(items.map(([id, nombre, sku], i) => ({ id, nombres: [nombre], sku, orden: i })));

test('el talle escrito de cualquier forma', () => {
  for (const [crudo, t] of [['XS', 'XS'], ['xxl', '2XL'], ['2XL', '2XL'], ['2 XL', '2XL'], ['XXXL', '3XL'], ['x-large', 'XL'], ['XX Small', '2XS'],
    ['3 X Large', '3XL'], ['Extra Large', 'XL'], ['Medium', 'M'], ['38', '38'], ['único', null], ['XM', null], ['', null]]) {
    assert.equal(talleCanonico(crudo)?.talle ?? null, t, crudo);
  }
});

test('el talle en el nombre', () => {
  assert.equal(talle('Campera Stone X Small - Negro - Algodon 100%'), 'XS');
  assert.equal(talle('Campera Softshell Race Hombre 3 X Large - Negro - Poliestileno'), '3XL');
  assert.equal(talle('Campera Polar Volley XX Large - Negro -'), '2XL');
  assert.equal(talle('Remera Regent Hombre Medium - Blanco - Algodon 100%'), 'M');
  assert.equal(talle('Remera Soul Negro XS'), 'XS');
  assert.equal(talle('Chomba Piqué Talle L'), 'L');
  assert.equal(talle('Pantalón de Gabardina Talle 44'), '44');
  // Lo que no es talle.
  assert.equal(talle('Remera M/C Blanca'), null);
  assert.equal(talle("Sol's Remera Regent Hombre"), null);
  assert.equal(talle('Botella Térmica 1 L'), null);
  assert.equal(talle('Gorro TAHG 169 c/broche Negro - Negro - Algodon 100%'), null);
  assert.equal(talle('Gorro Trucker Fluo Amarillo - Amarillo - .'), null);
  assert.equal(talle('PORTA TARJETA SUBE, AZUL CLARO PLENO Azul claro'), null);
  // La raíz: el nombre sin el talle.
  assert.equal(talleDeNombre('Campera Stone X Small - Negro - Algodon 100%').raiz, 'Campera Stone - Negro - Algodon 100%');
  // Un número suelto puede ser el modelo: queda como débil.
  assert.equal(talleDeNombre('Pantalón Cargo Unisex 34 - Beige - Algodon').debil, true);
});

test('el talle en el SKU de cada proveedor', () => {
  assert.deepEqual(talleDeSku('ZZ_ST_RM_JSMC_M_NE_2XL'), { talle: { talle: '2XL', familia: 'letra', orden: 80 }, raiz: 'ZZ_ST_RM_JSMC_M_NE', seguro: true });
  assert.equal(talleDeSku('ST_LS_BZ_FRCP_U_NE_XS')?.raiz, 'ST_LS_BZ_FRCP_U_NE');
  assert.equal(talleDeSku('ZZ_ST_PA01_G8GF_M_GT_38')?.talle.talle, '38');
  assert.equal(talleDeSku('ZEC_99030540300759799010')?.talle.talle, '4XL');
  assert.equal(talleDeSku('ZEC_05306000150759799999'), null);   // Tahg Gorro Flow: talle único
  assert.equal(talleDeSku('MYA_TEX305161756')?.talle.talle, 'L');
  assert.equal(talleDeSku('MYA_VAR020100252'), null);           // un porta SUBE, no es textil
  assert.equal(talleDeSku('IMP_P18.030.03'), null);             // el .03 de Promoproductos es el color
  assert.equal(talleDeSku('PS_GE_2000'), null);
  const t = (...xs) => xs.map(talleCanonico);
  // Un código numérico que sube con el talle (como Cardon y Maya), en un proveedor que no conocemos.
  assert.equal(raizComun(['NVO-7781-01', 'NVO-7781-02', 'NVO-7781-04'], t('S', 'M', 'XL')), 'NVO-7781-*');
  // Lo que cambia no es el talle: letras (un color), o números que no siguen a los talles.
  assert.equal(raizComun(['NVO-7781-NE', 'NVO-7781-RO'], t('S', 'M')), null);
  assert.equal(raizComun(['NVO-7781-07', 'NVO-7781-02'], t('S', 'M')), null);
  assert.equal(raizComun(['NVO-7781-02', 'NVO-7781-09'], t('S', 'M')), null);
  assert.equal(raizComun(['ZEC_99030777273D01D62D54', 'ZEC_21094000003D62D62D63'], t('S', 'M')), null);
});

test('PDV 31725: la Campera Stone en 5 talles es un solo producto, en el orden de los talles', () => {
  const g = grupos([
    ['l', 'Campera Stone Large - Negro - Algodon 100%', 'ZEC_99030777273D03D62D54'],
    ['xs', 'Campera Stone X Small - Negro - Algodon 100%', 'ZEC_99030777273D00D62D54'],
    ['s', 'Campera Stone Small - Negro - Algodon 100%', 'ZEC_99030777273D01D62D54'],
    ['m', 'Campera Stone Medium - Negro - Algodon 100%', 'ZEC_99030777273D02D62D54'],
    ['xl', 'Campera Stone X Large - Negro - Algodon 100%', 'ZEC_99030777273D04D62D54'],
  ]);
  assert.equal(g.grupos.length, 1);
  assert.equal(g.grupos[0].nombre, 'Campera Stone - Negro - Algodon 100%');
  assert.deepEqual(g.grupos[0].ids, ['xs', 's', 'm', 'l', 'xl']);
  assert.equal(g.grupos[0].clave, 'ZEC_99030777273D··D62D54');
});

test('PDV 30263: dos prendas con talles y un gorro sin talle', () => {
  const g = grupos([
    ['gorro', 'Gorro TAHG 169 c/broche Negro - Negro - Algodon 100%', 'ZEC_04037000006D62D62D54'],
    ...['Small', 'Medium', 'Large', 'X Large', 'XX Large', '3 X Large', '4 X Large'].map((t, i) => [`c${i}`, `Campera Softshell Race Hombre ${t} - Negro - Poliestileno`, `ZEC_99030777272D0${i + 1}D62D90`]),
    ...['Small', 'Medium', 'Large', 'X Large', 'XX Large', '3 X Large', '4 X Large'].map((t, i) => [`r${i}`, `Remera Regent Hombre ${t} - Blanco - Algodon 100%`, `ZEC_99030777277D0${i + 1}D22D54`]),
  ]);
  assert.equal(g.grupos.length, 2);
  assert.equal(g.grupoDe.get('gorro'), undefined);
  assert.deepEqual(g.grupos.map((x) => x.ids.length), [7, 7]);
  assert.deepEqual(g.grupos[1].ids.map((id) => g.talles.get(id).talle), ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL']);
});

test('el talle no siempre es el primer código de Zecat, y el color puede usar el mismo código', () => {
  // Buzo Hoodie Snake gris: el color va antes que el talle.
  const a = grupos(['X Small', 'Small', 'Medium'].map((t, i) => [`b${i}`, `Buzo Hoodie Snake ${t} - Gris claro - Algodon`, `ZEC_33014000011D55D0${i}D54`]));
  assert.equal(a.grupos.length, 1);
  // Una remera amarilla (D01) en talle S (D01): se resuelve con los otros talles.
  const b = grupos([['s', 'Remera Lake Small - Amarillo -', 'ZEC_22014000075D01D01'], ['m', 'Remera Lake Medium - Amarillo -', 'ZEC_22014000075D02D01'],
    ['l', 'Remera Lake Large - Amarillo -', 'ZEC_22014000075D03D01']]);
  assert.deepEqual(b.grupos[0]?.ids, ['s', 'm', 'l']);
});

test('lo que no se junta', () => {
  // El Gorro Trucker Fluo en tres colores: D01 es amarillo, no el talle S.
  const colores = grupos([['a', 'Gorro Trucker Fluo Amarillo - Amarillo - .', 'ZEC_99030777198D01D01D63'], ['v', 'Gorro Trucker Fluo Verde - Verde - .', 'ZEC_99030777198D85D85D63'],
    ['r', 'Gorro Trucker Fluo Rosa - Rosa - .', 'ZEC_99030777198D14D14D63']]);
  assert.equal(colores.grupos.length, 0);
  // El mismo SKU dos veces (dos logos), sin talle.
  assert.equal(grupos([['1', 'PORTA TARJETA SUBE, AZUL CLARO PLENO Azul claro', 'MYA_VAR020100252'], ['2', 'PORTA TARJETA SUBE, AZUL CLARO PLENO Azul claro', 'MYA_VAR020100252']]).grupos.length, 0);
  // Dos modelos distintos con el mismo nombre sin talle no se juntan si los SKU no se parecen.
  assert.equal(grupos([['a', 'Remera Small - Negro', 'ZEC_99030777277D01D62D54'], ['b', 'Remera Medium - Negro', 'ZEC_22014000075D02D62']]).grupos.length, 0);
  // Mismo modelo en dos colores: dos productos.
  const dos = grupos([['ns', 'Remera Lake Small - Negro -', 'ZEC_22014000075D01D62'], ['nm', 'Remera Lake Medium - Negro -', 'ZEC_22014000075D02D62'],
    ['rs', 'Remera Lake Small - Rojo -', 'ZEC_22014000075D01D76'], ['rm', 'Remera Lake Medium - Rojo -', 'ZEC_22014000075D02D76']]);
  assert.equal(dos.grupos.length, 2);
  // Números sueltos con un SKU genérico («Vaso 12 - Blanco», «Vaso 16 - Blanco»): no son talles.
  assert.equal(grupos([['a', 'Vaso 12 - Blanco', 'PS_GE_2000'], ['b', 'Vaso 16 - Blanco', 'PS_GE_2000']]).grupos.length, 0);
});

test('Soutex, Maya, Cardon y un proveedor desconocido', () => {
  assert.equal(grupos(['XS', 'S', '2XL'].map((t) => [t, 'Soutex Remera Soul', `ZZ_ST_RM_JSMC_M_NE_${t}`])).grupos[0]?.ids.join(), 'XS,S,2XL');
  assert.equal(grupos([['l', 'Suco Remera Oversize', 'MYA_TEX305161756'], ['s', 'Suco Remera Oversize', 'MYA_TEX305161754']]).grupos[0]?.ids.join(), 's,l');
  assert.equal(grupos([['m', 'Campera Windbreaker Medium - Negro', 'ZEC_99030540300759799004'], ['xs', 'Campera Windbreaker X Small - Negro', 'ZEC_99030540300759799002']])
    .grupos[0]?.ids.join(), 'xs,m');
  // Numéricos con el talle confirmado en el SKU de Zecat.
  assert.equal(grupos([['38', 'Pantalón Cargo Unisex 38 - Beige - Algodon', 'ZEC_99030778246D38D36D54'], ['36', 'Pantalón Cargo Unisex 36 - Beige - Algodon', 'ZEC_99030778246D36D36D54']])
    .grupos[0]?.ids.join(), '36,38');
  // Uno que no conocemos: el talle en el nombre y, en el SKU, el talle como tramo o un código que sube con el talle.
  assert.equal(grupos([['a', 'Chaleco Andes Talle M', 'NVO-7781-02'], ['b', 'Chaleco Andes Talle S', 'NVO-7781-01']]).grupos[0]?.ids.join(), 'b,a');
  assert.equal(grupos([['a', 'Chaleco Andes Talle M', 'NVO-7781-NE-M'], ['b', 'Chaleco Andes Talle XL', 'NVO-7781-NE-XL']]).grupos[0]?.ids.join(), 'a,b');
  // Sin SKU (artículos de ClickUp sin código): por el nombre.
  assert.equal(grupos([['a', 'Remera Algodón Talle L', null], ['b', 'Remera Algodón Talle S', null]]).grupos[0]?.ids.join(), 'b,a');
});

test('SOLO talles: nunca junta colores, materiales ni modelos distintos', () => {
  // Zecat: misma Campera Stone, Negro y Azul, en S y M → dos productos (uno por color), cada uno con sus talles.
  const colores = grupos([['ns', 'Campera Stone Small - Negro - Algodon 100%', 'ZEC_99030777273D01D62D54'], ['nm', 'Campera Stone Medium - Negro - Algodon 100%', 'ZEC_99030777273D02D62D54'],
    ['as', 'Campera Stone Small - Azul - Algodon 100%', 'ZEC_99030777273D01D09D54'], ['am', 'Campera Stone Medium - Azul - Algodon 100%', 'ZEC_99030777273D02D09D54']]);
  assert.deepEqual(colores.grupos.map((g) => g.ids.join()), ['ns,nm', 'as,am']);
  // Aunque el nombre no diga el color, el SKU lo separa.
  const sinColor = grupos([['n', "Sol's Campera Stone XS", 'ZEC_99030777273D00D62D54'], ['a', "Sol's Campera Stone S", 'ZEC_99030777273D01D09D54']]);
  assert.equal(sinColor.grupos.length, 0);
  // Mismo color, distinto material (D54 algodón, D90 poliéster).
  assert.equal(grupos([['a', 'Remera Small - Negro', 'ZEC_99030777277D01D62D54'], ['b', 'Remera Medium - Negro', 'ZEC_99030777277D02D62D90']]).grupos.length, 0);
  // Soutex y Maya: otro color en el SKU.
  assert.equal(grupos([['n', 'Soutex Remera Soul', 'ZZ_ST_RM_JSMC_M_NE_S'], ['b', 'Soutex Remera Soul', 'ZZ_ST_RM_JSMC_M_BL_M']]).grupos.length, 0);
  assert.equal(grupos([['a', 'Suco Remera Unisex', 'MYA_TEX305080254'], ['b', 'Suco Remera Unisex', 'MYA_TEX305090455']]).grupos.length, 0);
  // Un proveedor desconocido con el color como tramo del SKU.
  assert.equal(grupos([['a', 'Remera Talle M', 'NVO-7781-NE-M'], ['b', 'Remera Talle L', 'NVO-7781-RO-L']]).grupos.length, 0);
  // Un renglón sin SKU no se suma al grupo de los que tienen: sin SKU no se sabe el color.
  const mezcla = grupos([['a', 'Remera Lake Small - Negro -', 'ZEC_22014000075D01D62'], ['b', 'Remera Lake Medium - Negro -', 'ZEC_22014000075D02D62'],
    ['c', 'Remera Lake Large - Negro -', null]]);
  assert.deepEqual(mezcla.grupos.map((g) => g.ids.join()), ['a,b']);
  // Sin talle no hay grupo, aunque el nombre y el SKU se parezcan (modelos, colores).
  assert.equal(grupos([['a', 'Tahg Gorro 168 - Azul -', 'ZEC_04037000007D11D11D54'], ['b', 'Tahg Gorro 169 - Azul -', 'ZEC_04037000006D11D11D54']]).grupos.length, 0);
});

test('solo prendas: fuera de la ropa, «Large» o «S» es otra medida, no un talle', () => {
  const sinTalle = (nombre, sku = null) => agruparTalles([{ id: 'a', nombres: [nombre], sku }]).talles.size === 0;
  for (const n of ['Moleskine Cuaderno Classic Large Rayado', 'Moleskine Cuaderno Classic XL Rayado', 'Botella de Aluminio Landscape S 400 ml',
    'Wagner Bolso Sacken Medium 34 L', 'Tahg Caja Medium', 'Tahg Mochila para Notebook Cima S 12 L', 'Lona Playera XL con Funda', 'Billetera RTC Woman´s',
    'Mate Campero L', 'Riñonera Canguro M', 'Gorro Trucker S - Negro']) assert.ok(sinTalle(n), n);
  assert.equal(grupos([['l', 'Moleskine Cuaderno Classic Large Rayado', null], ['xl', 'Moleskine Cuaderno Classic XL Rayado', null]]).grupos.length, 0);
  // Las prendas sí, también con la marca adelante como en el shop.
  for (const n of ["Sol's Campera Stone XS", 'Remera Regent Hombre Small - Blanco - Algodon 100%', 'Chaleco Pampero Medium - Negro - Polar',
    'Buzo Hoodie Snake X Large - Gris claro -', 'Pantalón Recto de Gabardina Talle 44']) assert.ok(!sinTalle(n), n);
  // Un SKU de una línea textil alcanza (Soutex, Maya TEX), aunque el nombre no diga la prenda.
  assert.ok(!sinTalle('Soutex Soul', 'ZZ_ST_RM_JSMC_M_NE_M'));
});

test('el mismo producto con dos logos: dos tandas de talles', () => {
  const g = grupos([['a1', 'Remera Lake Small - Negro -', 'ZEC_22014000075D01D62'], ['a2', 'Remera Lake Medium - Negro -', 'ZEC_22014000075D02D62'],
    ['b1', 'Remera Lake Small - Negro -', 'ZEC_22014000075D01D62'], ['b2', 'Remera Lake Medium - Negro -', 'ZEC_22014000075D02D62']]);
  assert.deepEqual(g.grupos.map((x) => x.ids.join()), ['a1,a2', 'b1,b2']);
});

test('el costo del logo: el setup que el STP repite en cada talle va una sola vez', () => {
  // PDV 31725: 3, 4, 8, 12 y 3 unidades; el setup ($239.998) prorrateado en cada talle.
  const cant = [3, 4, 8, 12, 3];
  const c = costoLogoDeGrupo(cant.map((q) => ({ logo: 0, setup: 239998 / q, cantidad: q, fuente: 'pedido' })), cant);
  assert.equal(c.cantidad, 30);
  assert.equal(c.setup_una_vez, true);
  assert.equal(Math.round(c.setup), 8000);
  // Setups distintos: se suman.
  const d = costoLogoDeGrupo([{ logo: 100, setup: 10, cantidad: 10, fuente: 'costos' }, { logo: 100, setup: 0, cantidad: 10, fuente: 'costos' }], [10, 10]);
  assert.equal(d.logo, 100);
  assert.equal(d.setup, 5);
  assert.equal(d.setup_una_vez, undefined);
});

test('elegir el producto (boceto o logo desde el chat): la prenda con talles aparece una vez', () => {
  // Aviso de Rodrigo del 21/11/2026: «Cargar en un producto» listaba cada talle de la Campera Stone.
  const items = [
    { code: 'ZEC_99030777273D00D62D54', name: 'Campera Stone X Small - Negro - Algodon 100%', talle: 'XS', grupo: 'g1' },
    { code: 'ZEC_99030777273D01D62D54', name: 'Campera Stone Small - Negro - Algodon 100%', talle: 'S', grupo: 'g1' },
    { code: 'ZEC_99030777273D02D62D54', name: 'Campera Stone Medium - Negro - Algodon 100%', talle: 'M', grupo: 'g1' },
    { code: 'GORRO1', name: 'Gorro Trucker Fluo' },
    { code: 'ENVIO', name: 'Envío', tipo: 'servicio' },
  ];
  // El boceto de la prenda va con el código de su primer talle, como en la tarjeta de productos del pedido.
  assert.deepEqual(productosParaElegir(items, { g1: { nombre: 'Campera Stone - Negro - Algodon 100%' } }), [
    { key: 'ZEC_99030777273D00D62D54', nombre: 'Campera Stone - Negro - Algodon 100%' },
    { key: 'GORRO1', nombre: 'Gorro Trucker Fluo' },
  ]);
  // Sin la lista de grupos (un servidor viejo), cada renglón como antes.
  assert.equal(productosParaElegir(items).length, 4);
});

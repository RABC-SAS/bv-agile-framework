# Operacion del kit portable

## Destino y credenciales

Instala Node.js 22 o superior y GitHub CLI, la interfaz de linea de comandos de GitHub.
Ejecuta `npm ci --ignore-scripts`.
Autentica una cuenta ya autorizada para el destino; los scripts no amplian permisos ni crean identidades.
El piloto actual usa credenciales delegadas de `roanboc`, no una aprobacion de esa persona.

```powershell
$env:GH_TOKEN = gh auth token --user roanboc
if ($LASTEXITCODE -ne 0) { throw "No se pudo obtener la credencial" }
if ((gh api user --jq .login) -ne "roanboc") { throw "Identidad inesperada" }
```

Repite esa preparacion en cada proceso PowerShell.
El cliente prioriza `GH_TOKEN` sobre `GITHUB_TOKEN` tanto en consultas como en escrituras.
Nunca imprime ni almacena el token.
No copies esta credencial administrativa a GitHub Actions.
Una automatizacion real necesita una GitHub App de minimo privilegio y credenciales efimeras.
OpenID Connect, OIDC, puede sustituir secretos persistentes al acceder a proveedores compatibles.

En [pilot.yml](.github/planning/pilot.yml), configura:

| Clave | Uso |
| --- | --- |
| `organization`, `repository`, `expected_actor` | Destino y login delegado esperado. |
| `project.number`, `project.title` | Proyecto existente con identidad exacta. `number: null` descubre por titulo o crea uno si no existe. |
| `hierarchy` | Archivo de politica; el kit reemplaza sus coordenadas con las del destino. |
| `roles` | Dos nombres ficticios distintos; nunca el login delegado. |
| `fixture` | Un ejemplo identificado por clave y titulo SIMULADO. |
| `controls` | Rama, check y revisores propuestos; no se aplican. |
| `authorization_signer`, `authorization_public_key` dentro de `controls` | Humano independiente y clave publica Ed25519 obtenida fuera del agente. |

`expected_app_id: null` y revisores vacios son bloqueos administrativos explicitos, no valores listos para produccion.
No cambies de destino conservando el manifiesto anterior.
Los comandos antiguos `planning` leen directamente [hierarchy.yml](.github/planning/hierarchy.yml); actualiza tambien sus coordenadas antes de usarlos en otro destino.

## Diagnostico y plan

```powershell
npm test
npm run planning -- check-forms --dry-run
npm run pilot -- preflight
npm run pilot -- plan --dry-run
```

Ambos comandos remotos solo consultan GitHub.
Preflight verifica identidad, repositorio, proyecto, tipos, campos y capacidades administrativas.
Cada fallo de acceso queda en `access_errors`; el comando termina con error.
Un resultado inaccesible no equivale a configuracion ausente ni a cumplimiento.
La API es la interfaz de programacion de GitHub.
La paginacion admite hasta cien paginas y cada peticion tiene treinta segundos de limite.

El plan incluye `config_hash`, `plan_hash`, linea base y operaciones propuestas.
Antes de aplicar protecciones o permisos reales, una persona debe autorizar el destino y plan concretos.
Debe confirmar revisores disponibles, tratamiento de administradores y que el unico humano conserva una via operativa.
La ruta `apply-controls` requiere ademas un plan firmado por un humano independiente.
No se ejecuta durante esta entrega.

La propuesta exige PR, solicitud de cambios, con review independiente, descarte de reviews obsoletas y aprobacion del ultimo push por otro actor.
Tambien propone CODEOWNERS efectivos, checks de una App verificada, administradores sujetos a reglas y ningun bypass de agentes.
El check `pilot-tests` no esta desplegado: comprueba un productor confiable antes de hacerlo obligatorio.
Una persona siempre realiza el merge.

## Aplicacion administrativa autorizada

El adaptador admite solo crear un ruleset propio para la rama elegida.
Un ruleset es un conjunto de reglas de GitHub aplicado a una rama.
Usa una creacion `POST`, nunca una actualizacion que pueda sobrescribir protecciones concurrentes.
Rechaza protecciones de rama o rulesets preexistentes; su reconciliacion requiere intervencion manual.
La autorizacion consumida no se reutiliza, y repetir el comando no crea otro recurso.
El manifiesto conserva la respuesta y comprueba el ruleset creado y la ausencia de reglas concurrentes.

Antes de generar el plan, configura el App del check, revisores y la clave publica del firmante independiente.
La clave privada debe pertenecer exclusivamente al humano, fuera del repositorio y del alcance del agente.
La asociacion entre esa persona, login y clave publica requiere verificacion externa.
El kit no crea claves ni identidades reales.
El firmante debe ser un revisor configurado y distinto de la cuenta delegada del agente.
Debe conservar permiso administrativo verificable para recuperar la configuracion ante un bloqueo.
Para un unico humano, separa primero la identidad automatizada mediante un proceso administrativo autorizado.
No actives reglas que dejen a esa persona sin una via de trabajo.

El adaptador comprueba antes de escribir:

1. Hash integro del plan, configuracion/destino exactos y vigencia maxima de treinta minutos.
2. Firma Ed25519, firmante fijado, nonce no consumido y vigencia dentro de la del plan.
3. Estado base y SHA de rama sin cambios; permiso administrativo y visibilidad/plan compatibles con rulesets.
4. Auto-merge deshabilitado y permisos predeterminados de workflows en lectura, sin aprobacion automatizada de PR.
5. `.github/CODEOWNERS` en ese SHA, sin errores de GitHub, con una unica regla global `*` y los humanos configurados.
6. Escritura efectiva de cada code owner, administracion del firmante y check exitoso del SHA y App configurados.

La comprobacion de `User` y permisos solo acredita acceso; la firma externa aporta la autorizacion humana independiente.
Los CODEOWNERS mas complejos requieren revision manual; el adaptador no intenta interpretar patrones generales.
Para repositorios privados, exige comprobar un plan organizacional Team o Enterprise mediante la API.
Si el producto no expone esa capacidad, termina con bloqueo explicito.

Guarda la salida JSON, formato de intercambio estructurado, de `plan` en un archivo externo.
El humano firma el mensaje UTF-8 que produce `authorizationMessage` en [el adaptador](scripts/controls.mjs).
El mensaje contiene, en este orden, `kind`, `signer`, `repository`, `plan_hash`, `issued_at`, `expires_at` y `nonce`.
Usa `kind: human-signed-control-plan`, tiempos enteros en milisegundos y un nonce alfanumerico o con guiones de 16 a 128 caracteres.
La firma debe usar Ed25519 y guardarse como `signature` en base64 junto con esos campos.
El humano usa su mecanismo de firma externo; el agente no recibe la clave privada.

```powershell
# Ejemplo para un operador autorizado despues de configurar y firmar el plan.
# No ejecutar con la configuracion incompleta del piloto.
$plan = Get-Content "C:\evidencia\plan.json" -Raw | ConvertFrom-Json
$manifest = Join-Path $env:TEMP "bv-portable-pilot\controls.json"
npm run pilot -- apply-controls --apply --confirm ORGANIZACION/REPOSITORIO `
  --plan "C:\evidencia\plan.json" --authorize-controls $plan.plan_hash `
  --authorization "C:\evidencia\autorizacion-humana.json" --manifest $manifest
```

La firma y `--authorize-controls` deben referirse al mismo hash mostrado y revisado.
Las modificaciones del alcance administrativo, configuracion o estado base requieren otro plan y firma.
La configuracion del piloto deja esos prerrequisitos sin conceder.
Las pruebas usan claves efimeras en memoria y transporte falso; no configuran controles reales.

El ruleset exige PR, reviews independientes vigentes, CODEOWNERS, resolucion de conversaciones y el check del App esperado.
Impide eliminacion de rama y force-push; no define bypass, tampoco para administradores.
Una lectura de configuracion correcta no demuestra todavia el comportamiento de un flujo humano real.
Despues de aplicarlo, una persona debe verificar restricciones con una solicitud de cambios real.
Entornos de release, identidad App, scanners y despliegue de checks quedan fuera de esta escritura.
No se crean permisos, usuarios, secretos ni releases.

## Bootstrap explicito

Usa una ruta externa al repositorio para el manifiesto.
Elige una ruta estable y conserva el archivo como evidencia operativa, sin publicarlo completo.

```powershell
$manifest = Join-Path $env:TEMP "bv-portable-pilot\bootstrap.json"
npm run pilot -- bootstrap --dry-run
npm run pilot -- bootstrap --apply --confirm RABC-SAS/bv-agile-framework --manifest $manifest
```

Sustituye el destino de `--confirm` despues de lift-and-shift.
Sin `--apply`, bootstrap, fixtures y cleanup solo muestran un plan de lectura.
`--apply` y `--dry-run` juntos fallan.
La confirmacion es una proteccion contra errores operativos, no prueba de aprobacion humana.

Bootstrap reutiliza recursos compatibles y crea solo tipos/campos faltantes.
Un proyecto nuevo se crea mediante el identificador de organizacion descubierto.
Un proyecto numerado inaccesible, cerrado o con titulo distinto detiene el proceso; nunca crea un reemplazo.
Los conflictos de tipo, opciones o nombres tambien lo detienen.
El operador necesita permisos de escritura apropiados en organizacion y proyecto para cada recurso creado.
Un error de autorizacion no provoca ampliacion automatica de scopes.

El manifiesto registra recursos propios y ajenos, operaciones pendientes y verificacion de cada escritura.
El kit bloquea concurrencia sobre ese manifiesto con un archivo `.lock`.
No ejecutes dos manifiestos diferentes sobre el mismo destino simultaneamente.
Si el proceso muere dejando un lock, comprueba que termino antes de retirar solo ese archivo.
Una escritura incierta queda pendiente y bloquea reintentos ciegos.

## Proyecto y plantilla

El kit crea o reutiliza el contenedor Project; conserva sus vistas, opciones y automatizaciones.
Un Project nuevo puede no contener los estados requeridos por la politica.
Configura manualmente Backlog, Ready, In progress, In review y Done antes de crear fixtures.

En la tabla del proyecto, usa `+` > `Hidden fields` > `Type`, luego configura los campos visibles por vista.
No crees un campo custom llamado Type.
El kit no promete habilitarlo mediante una mutacion de campo custom.

En la configuracion de planificacion de la organizacion, comprueba la aplicabilidad de Cost Centre a Initiative, Epic y Feature.
Vincula el campo organizacional existente al proyecto, sin crear una copia local.
El bootstrap crea su definicion cuando falta; no configura su pinning.

Para una plantilla reutilizable, marca el proyecto apropiado como template desde sus ajustes, si tu producto y permisos lo permiten.
Comprueba esa capacidad en el destino.
El kit informa este paso manual; no modifica ni declara creada una plantilla compartida.
Si no dispones de la funcion, reutiliza la configuracion versionada y ejecuta bootstrap sobre un proyecto nuevo.

Los required reviewers de environments, entornos de despliegue, dependen del plan y visibilidad.
El soporte en un repositorio publico no demuestra soporte equivalente en uno privado.
Un solo revisor configurado puede bastar; impedir autoaprobacion y bypass administrativo requiere configuracion explicita.
Consulta las [reglas oficiales de environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

## Fixtures y recuperacion

```powershell
npm run pilot -- fixtures --dry-run
npm run pilot -- fixtures --apply --confirm RABC-SAS/bv-agile-framework --manifest $manifest
npm run pilot -- fixtures --apply --confirm RABC-SAS/bv-agile-framework --manifest $manifest
```

El ejemplo es un Feature raiz sintetico con tres secciones y checklists reales sin conceder.
El kit comprueba su tipo y lo incorpora al proyecto descubierto.
Comprueba membresia antes de incorporar; si compite con auto-add, relee y verifica.
La segunda ejecucion sobre el mismo estado no escribe.
Un titulo o marcador coincidente sin ownership registrado produce error, no adopcion.
Un cambio externo de cuerpo, tipo, titulo o estado detiene la reutilizacion.
El kit no sobrescribe el estado asignado por automatizaciones compartidas.

La API puede tardar en reflejar la membresia.
El kit realiza hasta cuatro lecturas, con esperas de 250, 500 y 1000 milisegundos.
Si no converge, conserva la operacion pendiente y termina con error.

```powershell
npm run pilot -- recover --manifest $manifest
```

`recover` solo resuelve una incorporacion al proyecto con respuesta e identidades ya registradas.
Revalida issue, proyecto y membresia; actualiza el journal local sin escrituras GitHub.
Otros fallos pendientes necesitan inspeccion manual; el kit no inventa ownership tras perder una respuesta.

Para cerrar el ejemplo propio:

```powershell
npm run pilot -- cleanup --apply --confirm RABC-SAS/bv-agile-framework --manifest $manifest
```

Cleanup cierra como maximo un fixture propio, tras comprobar identidad y contenido.
No borra issues, items, proyectos, tipos, campos ni vistas.
Conserva el item cerrado como evidencia y nunca afecta recursos ajenos.
La repeticion no vuelve a escribir.

## Simulacion y evidencia

```powershell
$simulation = Join-Path $env:TEMP "bv-portable-pilot\simulation.json"
$sha = git rev-parse HEAD
npm run pilot -- simulate --ticket 27 --sha $sha --scope "Piloto sintetico v1" --manifest $simulation
```

El numero de ticket es una referencia del escenario; el simulador offline no comprueba su existencia.
Usa el numero del fixture del destino o conserva el ejemplo sintetico predeterminado.
El artefacto predeterminado es sintetico; `--artifact` acepta un resumen SHA-256 de 64 caracteres hexadecimales.
Ninguna de esas referencias prueba una compilacion real.
Usa otro manifiesto para la simulacion y conserva el reporte del candidato exacto.

El recorrido comprueba propuesta, alcance, implementacion/checklist, verificacion, aceptacion, review, seguridad, pruebas finales y release.
Todas las decisiones humanas llevan `SIMULATED` y `human-simulated`.
La matriz contiene una ruta positiva y 87 negativas.
Un fallo de expectativa termina el comando con error.
Un consumidor de compuertas reales recibe rechazo aunque el ejercicio sea positivo.
El reporte conserva los identificadores consumidos; su almacenamiento local es evidencia sintetica, no un registro confiable de autorizacion humana.
No hay adaptador confiable de identidad humana ni verificacion de firmas.

## Validador y formularios

```powershell
npm run planning -- generate-forms
npm run planning -- check-forms --dry-run
npm run planning -- validate --numbers 27 --dry-run --manifest $manifest
```

La politica genera inputs separados al crear un issue y GitHub los convierte en secciones de un cuerpo Markdown.
Los formularios requieren Description al crear; criterios y evidencia pueden esperar su estado obligatorio.
Publicalos en la rama predeterminada mediante merge humano para ofrecerlos en la interfaz.
Editar por interfaz, agente o API no cambia el contrato de encabezados.

El validador rechaza Description ausente, vacia, duplicada o placeholder.
Rechaza duplicados de secciones opcionales incluso en Backlog.
Desde Ready exige Acceptance Criteria; desde In review exige tambien Delivery Evidence.
La regla aplica a Initiative, Epic, Feature y User Story; Bug Story, Task e issues sin tipo conservan su excepcion.
Una checklist de criterios sin marcar puede tener contenido valido; no representa aprobacion.
Fuera del proyecto no aplica compuertas por estado; conserva jerarquia, Description y aplicabilidad.

Sin `--dry-run`, `planning validate` publica o actualiza un unico comentario del mismo reporter.
Los comentarios son reportes editables, nunca aprobaciones humanas.
No cambia estados ni bloquea transiciones.
Los marcadores duplicados o ajenos provocan error.

Para extender campos, usa `storage: issue_body` con `heading` y `form_id`, o `storage: organization_field` con `data_type`.
Los tipos nativos admitidos son text, number, date, single_select y multi_select; las selecciones requieren opciones.
`required_on` y `required_from_status` determinan obligatoriedad acumulativa; `applies_to` determina aplicabilidad.
Regenera formularios y ejecuta pruebas despues de modificar la politica.
Las reglas nuevas fuera de este contrato requieren codigo y pruebas, no solo una clave YAML.

## Adopcion real

El plan administrativo y la aceptacion del simulador son decisiones diferentes.
PR, seguridad, pruebas finales del usuario, UAT, y release tambien requieren decisiones independientes del candidato exacto.
Un scanner, una review automatica o un checkbox no sustituyen esas decisiones.
Este kit no instala enforcement continuo, scanners, pipelines de release ni workflows privilegiados.
Los workflows futuros necesitan permisos minimos, acciones fijadas por SHA y aislamiento de codigo no confiable respecto de secretos.
No uses `pull_request_target` ni `workflow_run` para ejecutar codigo no confiable con permisos privilegiados.

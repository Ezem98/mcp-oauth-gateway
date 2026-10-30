# Guía de Despliegue en Producción — MCP OAuth Gateway + Google MCP

Esta guía detalla paso a paso la instalación, configuración y puesta en marcha del **MCP OAuth Gateway** y el servicio upstream **Google MCP** en un servidor Ubuntu 24.04 LTS (x86_64, systemd 255).

Se asume que el operador inicia sesión en el servidor con el usuario `minecraft` (con privilegios `sudo`), y que el agente de IA **OpenClaw** se ejecuta como el usuario del sistema `jarvis`.

---

## 1. Requisitos Previos

Verificar que Node.js y Git estén instalados en el sistema:

```bash
node --version
git --version
```

- **Node.js**: Requiere versión `>= 22.12.0` (por ejemplo `v24.22.2` en `/usr/bin/node`).
- **Compiladores C/C++ (`build-essential`)**: **NO son necesarios**. `better-sqlite3` v13 distribuye binarios precompilados N-API que se instalan de forma directa.

---

## 2. Crear el Usuario del Sistema

El gateway y el servidor Google MCP se ejecutan bajo un usuario de sistema dedicado sin privilegios y sin acceso a shell interactivo:

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin mcpgw
```

---

## 3. Clonar el Repositorio e Instalar Dependencias

Clonar el repositorio en `/opt/mcp-oauth-gateway`, asignar permisos al usuario `mcpgw` e instalar las dependencias de producción:

```bash
sudo git clone https://github.com/Ezem98/mcp-oauth-gateway /opt/mcp-oauth-gateway
cd /opt/mcp-oauth-gateway


sudo chown -R mcpgw:mcpgw /opt/mcp-oauth-gateway
# mcpgw no tiene home: la caché de npm va a /tmp y se borra después
sudo -u mcpgw env npm_config_cache=/tmp/mcpgw-npm-cache npm ci --omit=dev
sudo rm -rf /tmp/mcpgw-npm-cache
sudo -u mcpgw mkdir -p /opt/mcp-oauth-gateway/data
sudo -u mcpgw chmod 700 /opt/mcp-oauth-gateway/data
```

> [!WARNING]
> **NO crear ningún archivo `.env` dentro de `/opt/mcp-oauth-gateway/`**.
> El código del gateway carga dotenv con la opción `override: true`. Si existiera un `.env` en la raíz del proyecto, sobrescribiría las variables de entorno de producción provistas por systemd desde `/etc/mcp-gateway/env`.

---

## 4. Configurar `/etc/mcp-gateway`

Crear el directorio de configuración con permisos restringidos (`700`), copiar las plantillas y generar los secretos compartidos:

```bash
sudo install -d -m 700 -o mcpgw -g mcpgw /etc/mcp-gateway

# Copiar archivos base
sudo cp /opt/mcp-oauth-gateway/deploy/env.example /etc/mcp-gateway/env
sudo cp /opt/mcp-oauth-gateway/deploy/servers.example.json /etc/mcp-gateway/servers.json
sudo cp /opt/mcp-oauth-gateway/deploy/policies.json /etc/mcp-gateway/policies.json

# Asignar propietario mcpgw y permisos estrictos 600
sudo chown mcpgw:mcpgw /etc/mcp-gateway/*
sudo chmod 600 /etc/mcp-gateway/*
```

### Generación del secreto compartido Gateway ↔ Google MCP

Generar un secreto criptográfico de 32 bytes (64 caracteres hexadecimales):

```bash
openssl rand -hex 32
```

Copiar el valor generado y colocar **EXACTAMENTE EL MISMO VALOR** en ambos archivos:
1. En `/etc/mcp-gateway/env`:
   ```bash
   GOOGLE_MCP_SHARED_SECRET=<secreto_generado>
   ```
2. En `/etc/mcp-gateway/servers.json`:
   ```json
   "upstream_auth_header": "X-Google-MCP-Secret: <secreto_generado>"
   ```

Para editar los archivos manteniendo los permisos correctos:

```bash
sudo -u mcpgw nano /etc/mcp-gateway/env
sudo -u mcpgw nano /etc/mcp-gateway/servers.json
```
*(O utilizar `sudoedit /etc/mcp-gateway/env`)*

---

## 5. Configuración en Google Cloud Console

1. Acceder a [Google Cloud Console](https://console.cloud.google.com/).
2. Crear un proyecto (o seleccionar uno existente).
3. Habilitar las APIs necesarias en **APIs & Services > Library**:
   - **Gmail API** (`gmail.googleapis.com`)
   - **Google Drive API** (`drive.googleapis.com`)
4. Configurar la pantalla de consentimiento de OAuth (**OAuth consent screen**):
   - Tipo de usuario: **External**.
   - Completar nombre de app y correos de contacto.
   - Si la aplicación permanece en estado **Testing**, agregar la cuenta de Google personal (ej. `ezequiel...`) en la sección **Test users**.
   > [!NOTE]
   > En estado **Testing**, los *refresh tokens* de Google expiran a los 7 días. Para uso continuo sin reconexión semanal, se recomienda pasar la app a estado de producción (*In production*).
5. Crear credenciales OAuth en **Credentials > Create Credentials > OAuth client ID**:
   - Tipo de aplicación: **Web application**.
   - Nombre: `MCP Gateway Google Connector`.
   - **Authorized redirect URIs**: exactamente `http://localhost:4000/connect/google/callback`
6. Obtener el **Client ID** y el **Client Secret** y añadirlos en `/etc/mcp-gateway/env`:
   ```bash
   GOOGLE_CLIENT_ID=xxxxxxxxxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxx
   ```

---

## 6. Instalación y Activación de Servicios systemd

Copiar las unidades de servicio a systemd, recargar la configuración e iniciarlas:

```bash
sudo cp /opt/mcp-oauth-gateway/deploy/google-mcp.service /etc/systemd/system/
sudo cp /opt/mcp-oauth-gateway/deploy/mcp-gateway.service /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now google-mcp mcp-gateway
```

### Comprobar el estado y salud

Verificar que ambos servicios se encuentren activos (`active (running)`):

```bash
systemctl status google-mcp mcp-gateway
```

Ver los logs en tiempo real:

```bash
journalctl -u mcp-gateway -f
```

Verificar que el gateway responda en loopback local:

```bash
curl -s http://127.0.0.1:4000/health
```
Debe responder: `{"status":"ok","ts":"..."}`

---

## 7. Conectar la Cuenta de Google (Flujo Administrador)

Debido a que el gateway escucha exclusivamente en `127.0.0.1:4000` del servidor, la vinculación inicial de la cuenta de Google se realiza mediante un túnel SSH seguro desde tu equipo local (PC de Ezequiel).

### Paso 7.1: Abrir el túnel SSH en la PC local

En una terminal de tu PC local, ejecutar y mantener abierta la sesión:

```bash
ssh -L 4000:127.0.0.1:4000 minecraft@mc-server
```

*(Dejar esta terminal abierta durante todo el proceso de conexión)*.

### Paso 7.2: Obtener la URL de conexión en el servidor

En la terminal del servidor (como usuario `minecraft`), ejecutar:

```bash
sudo -u mcpgw bash -c 'set -a; . /etc/mcp-gateway/env; set +a; cd /opt/mcp-oauth-gateway && node --import tsx scripts/connect-url.ts ezequiel'
```

El script imprimirá una URL con el siguiente formato:
`http://localhost:4000/connect/google?user=ezequiel&admin=<token_secreto>`

> [!CAUTION]
> El parámetro `admin=` contiene el token administrativo de conexión (guardado en `/opt/mcp-oauth-gateway/data/connect-admin.token`). Es un secreto: **no lo pegues en chats públicos ni registros compartidos**.

> [!NOTE]
> Este mismo token de administrador es el que se requerirá más adelante en la pantalla de autorización OAuth (`/authorize`) al autorizar clientes como OpenClaw.

### Paso 7.3: Autorizar en el navegador

1. Abrir la URL impresa en el navegador web de tu PC local.
2. La petición viaja por el túnel SSH hacia el gateway. El gateway te redirige a la pantalla de consentimiento oficial de Google.
3. Iniciar sesión con tu cuenta de Google y conceder los permisos solicitados (Gmail y Drive).
4. Google redirige de vuelta a `http://localhost:4000/connect/google/callback` (a través del túnel local).
5. El navegador mostrará una página HTML confirmando: **"Cuenta de Google conectada"**.
6. Los tokens de acceso y refresco quedan cifrados con AES-256-GCM en `/opt/mcp-oauth-gateway/data/gateway.db`.

---

## 8. Vincular el Servidor con OpenClaw (Usuario `jarvis`)

OpenClaw se ejecuta bajo el usuario del sistema `jarvis`. Para conectarlo al servidor MCP Google a través del gateway:

### Paso 8.1: Registrar el servidor MCP en OpenClaw

Todos los comandos de esta sección se corren **como `jarvis`**, en una sesión aparte (`ssh jarvis@mc-server`). OpenClaw está instalado en `~/.npm-global/bin`, que no está en el PATH de `sudo -u jarvis`, por eso se usa la ruta completa:

```bash
~/.npm-global/bin/openclaw mcp add google \
  --url http://localhost:4000/google/mcp \
  --transport streamable-http \
  --auth oauth \
  --include gmail_search,gmail_read,gmail_create_draft,drive_search,drive_read
```

> [!IMPORTANT]
> **¿Por qué `localhost` y no `127.0.0.1`?**
> El gateway construye la audiencia del token (`aud`) y la metadata del recurso RFC 9728 a partir de `PUBLIC_URL=http://localhost:4000`. Por ende, OpenClaw debe usar exactamente el mismo origen (`http://localhost:4000`) en `--url`. Ambos nombres (`localhost` y `127.0.0.1`) resuelven a la interfaz loopback donde escucha el gateway, pero el estándar OAuth exige una coincidencia estricta de origen.

### Paso 8.2: Iniciar el inicio de sesión OAuth

OpenClaw recibe el callback de OAuth en `http://127.0.0.1:8989/oauth/callback` **del servidor**. Si ese puerto también viaja por el túnel, el navegador de tu PC se lo entrega directo y no hay que copiar ningún código a mano. En tu PC, abrí el túnel con los dos puertos (y dejalo abierto):

```bash
ssh -L 4000:127.0.0.1:4000 -L 8989:127.0.0.1:8989 minecraft@mc-server
```

Ejecutar en el servidor, como `jarvis`, y **no cortarlo con Ctrl+C** (queda esperando el navegador):

```bash
~/.npm-global/bin/openclaw mcp login google
```

1. OpenClaw imprime una URL de autorización:
   `http://localhost:4000/authorize?response_type=code&client_id=...`
2. Abrir esa URL en el navegador de tu PC.
3. Aparecerá la pantalla de autorización del gateway solicitando el **Token de administrador**.
   Para consultar el token en el servidor, ejecutar:
   ```bash
   sudo cat /opt/mcp-oauth-gateway/data/connect-admin.token
   ```
   > [!CAUTION]
   > Este token otorga privilegios de administrador para aprobar clientes OAuth y vincular credenciales en el gateway. **No lo pegues en ningún otro sitio** ni lo compartas en registros públicos o chats.
4. Pegar el token en el campo del formulario y hacer clic en **Approve**.
5. El navegador vuelve a `http://127.0.0.1:8989/oauth/callback?...`, el túnel lo lleva al servidor y `openclaw mcp login` termina solo.
6. **Plan B** (si abriste el túnel sin `-L 8989:...`): el navegador muestra *ERR_CONNECTION_REFUSED*. Copiá el parámetro `code` de la barra de direcciones y corré `~/.npm-global/bin/openclaw mcp login google --code <code>`. El código vence a los **60 segundos** y sirve una sola vez; si ves "The CLI command failed", lo más probable es que haya vencido: repetí desde `mcp login google`.
7. Verificar la conexión con el comando probe:
   ```bash
   ~/.npm-global/bin/openclaw mcp probe google
   ```
   Debe listar las 5 herramientas autorizadas (`gmail_search`, `gmail_read`, `gmail_create_draft`, `drive_search`, `drive_read`).
8. Recargar OpenClaw para aplicar la nueva configuración:
   ```bash
   ~/.npm-global/bin/openclaw mcp reload
   ```

### Paso 8.3: Política de Aprobaciones (Approvals)

OpenClaw permite configurar el modo de aprobación del servidor mediante el flag `--approval` (`openclaw mcp configure google --approval ...`):

```bash
~/.npm-global/bin/openclaw mcp configure google --approval auto
```

Opciones disponibles (`--approval prompt|auto|approve`):
- `auto`: **Recomendada**. Las herramientas se ejecutan automáticamente dentro de la sesión (postura de sesión) sin interrumpir al usuario en cada llamada.
- `prompt`: Solicita confirmación interactiva al operador antes de ejecutar cualquier herramienta.
- `approve`: Saltea la aprobación por llamada (todas las herramientas se ejecutan sin preguntar). Solo para servidores de total confianza.

> [!NOTE]
> **Detalles clave sobre la postura de aprobación:**
> 1. **Ámbito por servidor:** La configuración `--approval` aplica a **todo el servidor MCP**, no por herramienta individual. Por esta razón, **no es posible** configurar confirmación por prompt exclusivamente para `gmail_create_draft` mediante este flag general.
> 2. **Seguridad de `gmail_create_draft`:** Esta herramienta **únicamente crea borradores** en Gmail; nunca envía correos salientes ni despacha mensajes.
> 3. **Bloqueo a nivel de gateway:** Si se necesita restringir o bloquear una herramienta por completo, debe configurarse como `"deny"` en el archivo de políticas del gateway (`/etc/mcp-gateway/policies.json`).
> 4. **Permisos "Allow Always":** Si se prefiere operar bajo una postura más estricta (`prompt`), OpenClaw permite recordar autorizaciones con "Allow Always", las cuales sí se aplican de manera granular por herramienta individual a medida que se ejecutan.

---

## 9. Operaciones del Día 2 (Mantenimiento y Administración)

### 9.1. Auditoría de ejecuciones de herramientas

Para consultar qué acciones realizó Jarvis a través del gateway:

```bash
# Ver los últimos 50 eventos registrados
sudo -u mcpgw bash -c 'set -a; . /etc/mcp-gateway/env; set +a; cd /opt/mcp-oauth-gateway && node --import tsx scripts/audit.ts --limit 50'

# Ver únicamente llamadas bloqueadas por política
sudo -u mcpgw bash -c 'set -a; . /etc/mcp-gateway/env; set +a; cd /opt/mcp-oauth-gateway && node --import tsx scripts/audit.ts --blocked'
```

### 9.2. Bloquear o desbloquear una herramienta

Las políticas se configuran en `/etc/mcp-gateway/policies.json`.
Para bloquear una herramienta (por ejemplo, revocar `gmail_create_draft`):

1. Modificar `/etc/mcp-gateway/policies.json`:
   ```json
   {
     "google": {
       "gmail_search": "allow",
       "gmail_read": "allow",
       "gmail_create_draft": "deny",
       "drive_search": "allow",
       "drive_read": "allow"
     }
   }
   ```
2. Reiniciar el gateway para aplicar la nueva política:
   ```bash
   sudo systemctl restart mcp-gateway
   ```

### 9.3. Rotar el token administrativo (connect-admin.token)

El archivo `/opt/mcp-oauth-gateway/data/connect-admin.token` protege tanto la vinculación inicial de cuentas en `/connect/google` como la pantalla de consentimiento y autorización OAuth (`/authorize`). Si este token se ve comprometido:

```bash
sudo rm /opt/mcp-oauth-gateway/data/connect-admin.token
sudo systemctl restart mcp-gateway
```
El gateway generará un nuevo token seguro de forma automática al arrancar. A partir de ese momento, cualquier nuevo flujo de autorización de clientes en `/authorize` o conexión en `/connect/google` requerirá ingresar el nuevo token generado.

### 9.4. Reconexión de la cuenta de Google

Si alguna herramienta responde con el error `"Hay que reconectar la cuenta de Google"` (por ejemplo si expiró el refresh token tras 7 días en Testing o si fue revocado desde la configuración de seguridad de Google):
- Abrir nuevamente el túnel SSH `ssh -L 4000:127.0.0.1:4000 minecraft@mc-server`.
- Ejecutar el script `scripts/connect-url.ts` (Paso 7.2) y completar la autorización en el navegador.

### 9.5. Copias de seguridad (Backups)

El directorio de datos contiene el estado persistente del gateway:
- `/opt/mcp-oauth-gateway/data/vault.key`: Clave simétrica de cifrado.
- `/opt/mcp-oauth-gateway/data/gateway.db`: Base de datos SQLite (incluye tokens de Google cifrados).

> [!CRITICAL]
> **`vault.key` y `gateway.db` DEBEN respaldarse juntos**.
> Sin el archivo `vault.key`, es matemáticamente imposible descifrar los tokens almacenados en `credential_vault`.

Para realizar un respaldo:

```bash
sudo bash -c 'umask 077; tar -czf /home/minecraft/mcp-gateway-backup-$(date +%F).tar.gz -C /opt/mcp-oauth-gateway data'
```

### 9.6. Actualizaciones de código

Para actualizar la aplicación a una versión más reciente:

```bash
cd /opt/mcp-oauth-gateway
sudo -u mcpgw git pull --ff-only
# mcpgw no tiene home: la caché de npm va a /tmp y se borra después
sudo -u mcpgw env npm_config_cache=/tmp/mcpgw-npm-cache npm ci --omit=dev
sudo rm -rf /tmp/mcpgw-npm-cache
sudo systemctl restart google-mcp mcp-gateway
```

---

## 10. Consideraciones de Seguridad

1. **Aislamiento en Loopback**:
   Tanto el gateway (`127.0.0.1:4000`) como el upstream Google MCP (`127.0.0.1:5002`) escuchan **únicamente** en interfaces loopback. Nunca deben exponerse a redes públicas, 0.0.0.0 o herramientas como `tailscale serve` sin una capa de autenticación perimetral estricta.
2. **Hardening de systemd**:
   Ambos servicios se ejecutan con `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `NoNewPrivileges=true`, `UMask=0077` y capacidades reducidas. El único directorio con permiso de escritura en todo el sistema de archivos es `/opt/mcp-oauth-gateway/data` para el gateway.
3. **Mínimo Privilegio en Herramientas de Google**:
   El servidor Google MCP está diseñado como solo lectura y creación de borradores (`search`, `read`, `create_draft`). **Nunca** envía correos salientes automáticamente, **nunca** borra archivos de Drive y **nunca** modifica listas de control de acceso ni permisos compartidos.

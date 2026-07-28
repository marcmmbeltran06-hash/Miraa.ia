# Conexión local de WordPress con Codex

AutoWP registra un servidor MCP local llamado `autowp_wordpress`. Solo acepta sitios en `localhost`, `127.0.0.1` o `::1` y nunca se conecta a WordPress.com.

## Seguridad

- La autenticación usa una contraseña de aplicación de WordPress exclusiva y revocable.
- Las credenciales se guardan únicamente dentro de `generated-sites/<job>/imports/wordpress-agent-credentials.json`.
- El secreto no se incluye en `.codex/config.toml`, en el código ni en los resultados de las herramientas.
- Las modificaciones utilizan el plugin `AutoWP WordPress Agent`: primero se genera una vista previa, después se aplica con autorización explícita y se conserva un `historyId` para rollback.

## Activación

1. Mantén el WordPress generado en ejecución.
2. Reinicia Codex después de crear o actualizar `.codex/config.toml`.
3. En **Settings → MCP servers**, comprueba que `autowp_wordpress` esté habilitado.
4. Pide: `Comprueba el estado de mi WordPress local`.

El conector descubre primero el sitio generado más reciente que esté accesible y tenga credenciales válidas.

## Herramientas disponibles

- Estado del sitio y usuario autenticado.
- Listado y lectura de páginas.
- Preparación de cambios con vista previa.
- Aplicación explícita de un plan.
- Historial y rollback.

Para revocar el acceso, entra en **Usuarios → Perfil → Contraseñas de aplicación** y elimina `Codex Local AutoWP`.

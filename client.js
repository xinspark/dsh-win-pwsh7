// client.js — the browser half of dsh-win-pwsh7: the configure card and the status card
// on the plugin pages. Both use the same chrome as the installed dsh-ops branch — a 0.5px
// hairline card on radius-lg, a shaded card body, 13px/600 titles and max-content fact
// labels — while the Host page keeps its own 32px rhythm between detail sections.
//
// One operation, two callers: the diagnostics section and the re-detect button call the
// same Host method (`status`) that the `pwsh7_status` agent tool runs — over the Remote
// channel declared by this package's build-time typert contract (lib/typert.host.js).
// Styles use only --dsw-alias-* theme tokens and render as React elements, so unmounting
// removes them; class names carry the dw7- prefix.

window.__ModuleLoader__.load({
  id: 'dsh-win-pwsh7',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useSyncExternalStore } = React

    const PACKAGE = 'dsh-win-pwsh7'
    const ROW_ID = 'win-pwsh7'
    const SLOT_KEY = PACKAGE + '#' + ROW_ID

    function describe(error) {
      return error instanceof Error ? error.message : String(error)
    }

    // ---- Remote plumbing (the client half of the four-block typert contract) ----

    function descriptorsFor(pkg, endpoints) {
      const argsCodec = () => ({
        mode: 'strict',
        typeSymbol: pkg + '/typert#EndpointArgs',
        create: () => ({
          parse(value) {
            if (value === null || typeof value !== 'object' || Array.isArray(value)) {
              throw new TypeError(pkg + ': endpoint args must be a plain object')
            }
            return value
          },
        }),
      })
      return endpoints.map((name) => ({
        id: pkg + '#' + pkg + '/' + name,
        service: pkg,
        namespace: pkg, // must be the package name: the client-side service key is remote.<namespace>
        method: name,
        invocation: { kind: 'direct' },
        parameters: [{ name: 'args', wire: 'args', source: 'json', codec: argsCodec() }],
        result: { mode: 'src-json' }, // the gateway passes results through; the caller unwraps the envelope
        // Deliberate asymmetry, not drift: the *Host* manifest carries the strict result codec
        // (`exports["./typert"]` / lib/typert.host.js), while the client-side descriptor asks for
        // `src-json` and unwraps one RemoteResult envelope — that is the protocol's two-sided shape,
        // and the descriptor above is its documented form. Changing it to a strict codec here would
        // break a channel that is live-verified working.
      }))
    }

    /** The remote method answers a RemoteResult envelope {ok,value}|{ok,error}; callers want the raw value. */
    function unwrapRemoteResult(res) {
      if (!res || typeof res !== 'object' || typeof res.ok !== 'boolean') return res
      if (res.ok === true && 'value' in res) return res.value
      if (res.ok === false && res.error && typeof res.error === 'object') {
        const failure = res.error
        const err = new Error('remote ' + (failure.code || 'unknown') + (failure.message ? ': ' + failure.message : ''))
        err.code = failure.code
        err.remote = failure
        throw err
      }
      return res
    }

    // ---- locale dictionaries (en must stay Chinese-free) ----

    const DICT_EN = {
      diagnostics_title: 'PowerShell 7 status',
      status_error: 'Detection failed: {error}',
      refreshed_at: 'refreshed {at}',
      status_ready: 'Ready',
      status_denied: 'Blocked',
      status_detecting: 'Detecting',
      status_row_status: 'Status',
      status_row_runtime: 'Runtime',
      status_row_path: 'Executor',
      status_no_runtime: 'PowerShell 7 not found',
      status_no_path: 'Not resolved',
      status_lead_ready: 'The pwsh tool is allowed and will use the runtime below.',
      status_lead_windows: 'The pwsh tool is blocked: the executor still resolves to Windows PowerShell {version}.',
      status_lead_no_ps7: 'The pwsh tool is blocked: no usable PowerShell 7 was found.',
      status_lead_broken: 'The pwsh tool is blocked: the executor pins a path that does not exist.',
      status_lead_unknown: 'The PowerShell runtime the executor will use could not be determined.',
      status_lead_detecting: 'Detecting the PowerShell runtime…',
      status_note_ready: 'The pwsh tool is allowed only when the executor really resolves PowerShell 7 or newer.',
      status_note_store: 'The path is the version-stable Store family alias, so Store updates do not move it. AppInfo activation is undocumented; if it stops working, run pwsh7_install or pin an ordinary pwsh.exe.',
      status_note_denied: 'Press Re-detect to refresh; or have the model call pwsh7_status for the wiring patch and install guidance.',
      status_note_broken: 'Replace or remove that pwshPath, or run pwsh7_install again.',
      status_note_detecting: 'The first detection usually finishes quickly.',
      redetect: 'Re-detect',
      redetecting: 'Detecting…',
      star: '⭐ Finding it useful? Star it on GitHub',
      card_title: 'Configuration',
      executor_title: 'PowerShell 7 executor',
      executor_hint: 'The runtime the pwsh tool runs. This page only probes and recommends; the profile patch in the status section does the wiring.',
      field_overridePath: 'PowerShell 7 path',
      overridePath_hint: 'Optional explicit pwsh.exe path (`overridePath`). Empty = auto-detect. It must spawn and report PowerShell 7 or newer; the Store family alias is accepted, while a version-numbered Store path is never pinned. This only changes what the plugin probes and recommends — it does not wire the pwsh tool. Use the patch in the status section for that.',
      save: 'Save',
      reset: 'Reset',
      saved: 'Saved {at}',
      save_rejected: 'The Host rejected the write.',
      form_loading: 'Loading configuration…',
      form_unavailable: 'Configuration is not available right now.',
      unwritable: 'The Host is not accepting writes for this row.',
      error_remote_unavailable: 'the Remote service is not available in this deployment',
      error_endpoint_missing: 'the status endpoint is not mounted',
      copy_patch: 'Copy patch',
      copied: 'Copied',
      copy_failed: 'Copy failed — select the patch text and copy it manually.',
      patch_note: 'Paste this into the profile patch and restart DSH. The config block replaces the row wholesale.',
    }
    const DICT_ZH = {
      diagnostics_title: 'PowerShell 7 状态',
      status_error: '检测失败：{error}',
      refreshed_at: '刷新于 {at}',
      status_ready: '已就绪',
      status_denied: '未就绪',
      status_detecting: '检测中',
      status_row_status: '状态',
      status_row_runtime: '运行时',
      status_row_path: '执行器',
      status_no_runtime: '未检测到 PowerShell 7',
      status_no_path: '未解析到路径',
      status_lead_ready: 'pwsh 工具已放行，将使用下面的运行时执行。',
      status_lead_windows: 'pwsh 工具已被拦截：执行器仍解析到 Windows PowerShell {version}。',
      status_lead_no_ps7: 'pwsh 工具已被拦截：没有可用的 PowerShell 7。',
      status_lead_broken: 'pwsh 工具已被拦截：执行器 pin 的路径不可用。',
      status_lead_unknown: '尚无法确认执行器将运行的 PowerShell 版本。',
      status_lead_detecting: '正在检测 PowerShell 运行时…',
      status_note_ready: '只有实际解析到 PowerShell 7 及以上时，pwsh 工具才会放行。',
      status_note_store: '该路径是版本稳定的 Store 家族别名，Store 更新不会移动它。AppInfo 激活是未公开行为；如果失效，请运行 pwsh7_install 或 pin 普通 pwsh.exe。',
      status_note_denied: '点「重新检测」刷新；或让模型调用 pwsh7_status 获取接线补丁与安装指引。',
      status_note_broken: '请更换或移除该 pwshPath，或重新运行 pwsh7_install。',
      status_note_detecting: '首次检测通常很快。',
      redetect: '重新检测',
      redetecting: '检测中…',
      star: '⭐ 用着顺手？给个 Star 支持一下',
      card_title: '配置',
      executor_title: 'PowerShell 7 执行器',
      executor_hint: 'pwsh 工具实际运行的 PowerShell。本页只做探测与推荐；接线用状态区里的 profile 补丁。',
      field_overridePath: 'PowerShell 7 路径',
      overridePath_hint: '可选的显式 pwsh.exe 路径（`overridePath`）。留空 = 自动探测。必须能启动并报告 PowerShell 7 及以上；Store 家族别名可用，版本号目录永不被 pin。这里只影响插件的探测与推荐，不会给 pwsh 工具接线；接线请用状态区里的补丁。',
      save: '保存',
      reset: '重置',
      saved: '已保存 {at}',
      save_rejected: 'Host 拒绝了这次写入。',
      form_loading: '配置读取中…',
      form_unavailable: '配置暂不可用。',
      unwritable: 'Host 当前不接受该行的写入。',
      error_remote_unavailable: '本部署没有可用的 Remote 服务',
      error_endpoint_missing: '状态端点未挂载',
      copy_patch: '复制补丁',
      copied: '已复制',
      copy_failed: '复制失败——请手动选中补丁文本复制。',
      patch_note: '把这段粘贴进 profile 补丁并重启 DSH；config 会整体替换该行的配置。',
    }
    const DICT_JA = {
      diagnostics_title: 'PowerShell 7 の状態',
      status_error: '検出に失敗しました：{error}',
      refreshed_at: '{at} に更新',
      status_ready: '準備完了',
      status_denied: 'ブロック中',
      status_detecting: '検出中',
      status_row_status: '状態',
      status_row_runtime: 'ランタイム',
      status_row_path: '実行環境',
      status_no_runtime: 'PowerShell 7 が見つかりません',
      status_no_path: '未解決',
      status_lead_ready: 'pwsh ツールは許可されており、以下のランタイムで実行されます。',
      status_lead_windows: 'pwsh ツールはブロックされています：実行環境は依然として Windows PowerShell {version} を解決しています。',
      status_lead_no_ps7: 'pwsh ツールはブロックされています：使用可能な PowerShell 7 が見つかりません。',
      status_lead_broken: 'pwsh ツールはブロックされています：実行環境が存在しないパスを固定しています。',
      status_lead_unknown: '実行環境が使用する PowerShell ランタイムを特定できませんでした。',
      status_lead_detecting: 'PowerShell ランタイムを検出しています…',
      status_note_ready: '実行環境が実際に PowerShell 7 以上を解決した場合にのみ、pwsh ツールは許可されます。',
      status_note_store: 'このパスはバージョンに依存しない Store ファミリ別名のため、Store の更新では移動しません。AppInfo のアクティブ化は非公開の動作です。機能しなくなった場合は pwsh7_install を実行するか、通常の pwsh.exe を固定してください。',
      status_note_denied: '「再検出」で更新するか、モデルに pwsh7_status を呼ばせて接続パッチとインストール手順を取得してください。',
      status_note_broken: 'その pwshPath を変更または削除するか、pwsh7_install を再実行してください。',
      status_note_detecting: '初回の検出は通常すぐに完了します。',
      redetect: '再検出',
      redetecting: '検出中…',
      star: '⭐ 気に入ったら GitHub で Star をお願いします',
      card_title: '設定',
      executor_title: 'PowerShell 7 実行環境',
      executor_hint: 'pwsh ツールが実際に実行する PowerShell。このページは検出と推奨のみを行います。接続は状態セクションの profile パッチで行います。',
      field_overridePath: 'PowerShell 7 のパス',
      overridePath_hint: '任意の明示的な pwsh.exe パス（`overridePath`）。空 = 自動検出。起動して PowerShell 7 以上を報告する必要があります。Store ファミリ別名は使用できますが、バージョン番号付きの Store パスは固定されません。これはプラグインの検出と推奨のみを変更し、pwsh ツールの接続は行いません。接続には状態セクションのパッチを使用してください。',
      save: '保存',
      reset: 'リセット',
      saved: '{at} に保存',
      save_rejected: 'Host が書き込みを拒否しました。',
      form_loading: '設定を読み込み中…',
      form_unavailable: '現在、設定を利用できません。',
      unwritable: 'Host はこの行への書き込みを受け付けていません。',
      error_remote_unavailable: 'このデプロイでは Remote サービスを利用できません',
      error_endpoint_missing: '状態エンドポイントがマウントされていません',
      copy_patch: 'パッチをコピー',
      copied: 'コピーしました',
      copy_failed: 'コピーに失敗しました — パッチテキストを選択して手動でコピーしてください。',
      patch_note: 'これを profile パッチに貼り付けて DSH を再起動してください。config はその行の設定を丸ごと置き換えます。',
    }
    const DICT_DE = {
      diagnostics_title: 'PowerShell 7-Status',
      status_error: 'Erkennung fehlgeschlagen: {error}',
      refreshed_at: 'aktualisiert {at}',
      status_ready: 'Bereit',
      status_denied: 'Blockiert',
      status_detecting: 'Wird erkannt',
      status_row_status: 'Status',
      status_row_runtime: 'Laufzeit',
      status_row_path: 'Executor',
      status_no_runtime: 'PowerShell 7 nicht gefunden',
      status_no_path: 'Nicht aufgelöst',
      status_lead_ready: 'Das pwsh-Tool ist erlaubt und verwendet die unten stehende Laufzeit.',
      status_lead_windows: 'Das pwsh-Tool ist blockiert: Der Executor löst weiterhin Windows PowerShell {version} auf.',
      status_lead_no_ps7: 'Das pwsh-Tool ist blockiert: Es wurde kein nutzbares PowerShell 7 gefunden.',
      status_lead_broken: 'Das pwsh-Tool ist blockiert: Der Executor pinnt einen Pfad, der nicht existiert.',
      status_lead_unknown: 'Die PowerShell-Laufzeit, die der Executor verwendet, konnte nicht bestimmt werden.',
      status_lead_detecting: 'PowerShell-Laufzeit wird erkannt…',
      status_note_ready: 'Das pwsh-Tool ist nur erlaubt, wenn der Executor tatsächlich PowerShell 7 oder neuer auflöst.',
      status_note_store: 'Der Pfad ist der versionsstabile Store-Familienalias, daher verschieben ihn Store-Updates nicht. Die AppInfo-Aktivierung ist undokumentiert; falls sie nicht mehr funktioniert, führen Sie pwsh7_install aus oder pinnen Sie eine gewöhnliche pwsh.exe.',
      status_note_denied: 'Drücken Sie „Neu erkennen“, oder lassen Sie das Modell pwsh7_status für den Verdrahtungs-Patch und die Installationshinweise aufrufen.',
      status_note_broken: 'Ersetzen oder entfernen Sie diesen pwshPath, oder führen Sie pwsh7_install erneut aus.',
      status_note_detecting: 'Die erste Erkennung ist normalerweise schnell abgeschlossen.',
      redetect: 'Neu erkennen',
      redetecting: 'Erkennung…',
      star: '⭐ Nützlich? Gib uns einen Star auf GitHub',
      card_title: 'Konfiguration',
      executor_title: 'PowerShell 7-Executor',
      executor_hint: 'Die Laufzeit, die das pwsh-Tool ausführt. Diese Seite prüft und empfiehlt nur; die Verdrahtung erfolgt über den profile-Patch im Statusbereich.',
      field_overridePath: 'PowerShell 7-Pfad',
      overridePath_hint: 'Optionaler expliziter pwsh.exe-Pfad (`overridePath`). Leer = automatische Erkennung. Die Datei muss starten und PowerShell 7 oder neuer melden; der Store-Familienalias wird akzeptiert, ein versionsnummerierter Store-Pfad wird nie gepinnt. Dies ändert nur, was das Plugin prüft und empfiehlt — es verdrahtet das pwsh-Tool nicht. Verwenden Sie dafür den Patch im Statusbereich.',
      save: 'Speichern',
      reset: 'Zurücksetzen',
      saved: 'Gespeichert {at}',
      save_rejected: 'Der Host hat den Schreibvorgang abgelehnt.',
      form_loading: 'Konfiguration wird geladen…',
      form_unavailable: 'Die Konfiguration ist derzeit nicht verfügbar.',
      unwritable: 'Der Host akzeptiert keine Schreibvorgänge für diese Zeile.',
      error_remote_unavailable: 'Der Remote-Dienst ist in dieser Bereitstellung nicht verfügbar',
      error_endpoint_missing: 'Der Status-Endpunkt ist nicht eingebunden',
      copy_patch: 'Patch kopieren',
      copied: 'Kopiert',
      copy_failed: 'Kopieren fehlgeschlagen — markieren Sie den Patch-Text und kopieren Sie ihn manuell.',
      patch_note: 'Fügen Sie dies in den profile-Patch ein und starten Sie DSH neu. Der config-Block ersetzt die Konfiguration der Zeile vollständig.',
    }
    const DICT_ES = {
      diagnostics_title: 'Estado de PowerShell 7',
      status_error: 'Error de detección: {error}',
      refreshed_at: 'actualizado {at}',
      status_ready: 'Listo',
      status_denied: 'Bloqueado',
      status_detecting: 'Detectando',
      status_row_status: 'Estado',
      status_row_runtime: 'Runtime',
      status_row_path: 'Ejecutor',
      status_no_runtime: 'PowerShell 7 no encontrado',
      status_no_path: 'Sin resolver',
      status_lead_ready: 'La herramienta pwsh está permitida y usará el runtime siguiente.',
      status_lead_windows: 'La herramienta pwsh está bloqueada: el ejecutor sigue resolviendo a Windows PowerShell {version}.',
      status_lead_no_ps7: 'La herramienta pwsh está bloqueada: no se encontró un PowerShell 7 utilizable.',
      status_lead_broken: 'La herramienta pwsh está bloqueada: el ejecutor fija una ruta que no existe.',
      status_lead_unknown: 'No se pudo determinar el runtime de PowerShell que usará el ejecutor.',
      status_lead_detecting: 'Detectando el runtime de PowerShell…',
      status_note_ready: 'La herramienta pwsh solo se permite cuando el ejecutor resuelve realmente PowerShell 7 o superior.',
      status_note_store: 'La ruta es el alias de familia de Store estable en versión, por lo que las actualizaciones de Store no la mueven. La activación de AppInfo no está documentada; si deja de funcionar, ejecute pwsh7_install o fije un pwsh.exe normal.',
      status_note_denied: 'Pulse «Volver a detectar» para actualizar, o pida al modelo que llame a pwsh7_status para obtener el parche de conexión y las instrucciones de instalación.',
      status_note_broken: 'Reemplace o elimine ese pwshPath, o vuelva a ejecutar pwsh7_install.',
      status_note_detecting: 'La primera detección suele terminar rápidamente.',
      redetect: 'Volver a detectar',
      redetecting: 'Detectando…',
      star: '⭐ ¿Te resulta útil? Danos una estrella en GitHub',
      card_title: 'Configuración',
      executor_title: 'Ejecutor de PowerShell 7',
      executor_hint: 'El runtime que ejecuta la herramienta pwsh. Esta página solo sondea y recomienda; el cableado se hace con el parche de profile del área de estado.',
      field_overridePath: 'Ruta de PowerShell 7',
      overridePath_hint: 'Ruta explícita opcional de pwsh.exe (`overridePath`). Vacío = detección automática. Debe iniciarse y notificar PowerShell 7 o superior; se acepta el alias de familia de Store, pero nunca se fija una ruta de Store numerada por versión. Esto solo cambia lo que el plugin sondea y recomienda; no conecta la herramienta pwsh. Para eso, use el parche del área de estado.',
      save: 'Guardar',
      reset: 'Restablecer',
      saved: 'Guardado {at}',
      save_rejected: 'El Host rechazó la escritura.',
      form_loading: 'Cargando configuración…',
      form_unavailable: 'La configuración no está disponible ahora mismo.',
      unwritable: 'El Host no acepta escrituras para esta fila.',
      error_remote_unavailable: 'el servicio Remote no está disponible en esta implementación',
      error_endpoint_missing: 'el endpoint de estado no está montado',
      copy_patch: 'Copiar parche',
      copied: 'Copiado',
      copy_failed: 'Error al copiar — selecciona el texto del parche y cópialo manualmente.',
      patch_note: 'Pega esto en el parche del profile y reinicia DSH. El bloque config reemplaza la configuración de la fila por completo.',
    }
    const DICT_FR = {
      diagnostics_title: 'État de PowerShell 7',
      status_error: 'Échec de la détection : {error}',
      refreshed_at: 'actualisé {at}',
      status_ready: 'Prêt',
      status_denied: 'Bloqué',
      status_detecting: 'Détection',
      status_row_status: 'État',
      status_row_runtime: 'Runtime',
      status_row_path: 'Exécuteur',
      status_no_runtime: 'PowerShell 7 introuvable',
      status_no_path: 'Non résolu',
      status_lead_ready: "L'outil pwsh est autorisé et utilisera le runtime ci-dessous.",
      status_lead_windows: "L'outil pwsh est bloqué : l'exécuteur résout toujours Windows PowerShell {version}.",
      status_lead_no_ps7: "L'outil pwsh est bloqué : aucun PowerShell 7 utilisable n'a été trouvé.",
      status_lead_broken: "L'outil pwsh est bloqué : l'exécuteur épingle un chemin qui n'existe pas.",
      status_lead_unknown: "Impossible de déterminer le runtime PowerShell que l'exécuteur utilisera.",
      status_lead_detecting: 'Détection du runtime PowerShell…',
      status_note_ready: "L'outil pwsh n'est autorisé que lorsque l'exécuteur résout réellement PowerShell 7 ou supérieur.",
      status_note_store: "Le chemin est l'alias de famille Store stable en version ; les mises à jour du Store ne le déplacent donc pas. L'activation AppInfo n'est pas documentée ; si elle cesse de fonctionner, exécutez pwsh7_install ou épinglez un pwsh.exe ordinaire.",
      status_note_denied: "Cliquez sur « Re-détecter » pour actualiser, ou demandez au modèle d'appeler pwsh7_status pour le correctif de câblage et les instructions d'installation.",
      status_note_broken: 'Remplacez ou supprimez ce pwshPath, ou relancez pwsh7_install.',
      status_note_detecting: 'La première détection se termine généralement rapidement.',
      redetect: 'Re-détecter',
      redetecting: 'Détection…',
      star: '⭐ Utile ? Laissez-nous une étoile sur GitHub',
      card_title: 'Configuration',
      executor_title: 'Exécuteur PowerShell 7',
      executor_hint: "Le runtime que l'outil pwsh exécute. Cette page ne fait que sonder et recommander ; le câblage se fait via le patch de profile de la zone d'état.",
      field_overridePath: 'Chemin de PowerShell 7',
      overridePath_hint: "Chemin explicite facultatif de pwsh.exe (`overridePath`). Vide = détection automatique. Il doit démarrer et signaler PowerShell 7 ou supérieur ; l'alias de famille Store est accepté, mais un chemin Store numéroté par version n'est jamais épinglé. Cela ne change que ce que le plugin sonde et recommande — cela ne câble pas l'outil pwsh. Utilisez le patch de la zone d'état pour cela.",
      save: 'Enregistrer',
      reset: 'Réinitialiser',
      saved: 'Enregistré {at}',
      save_rejected: "L'Host a refusé l'écriture.",
      form_loading: 'Chargement de la configuration…',
      form_unavailable: "La configuration n'est pas disponible pour le moment.",
      unwritable: "L'Host n'accepte pas d'écriture pour cette ligne.",
      error_remote_unavailable: "le service Remote n'est pas disponible dans ce déploiement",
      error_endpoint_missing: "le point de terminaison d'état n'est pas monté",
      copy_patch: 'Copier le correctif',
      copied: 'Copié',
      copy_failed: 'Échec de la copie — sélectionnez le texte du correctif et copiez-le manuellement.',
      patch_note: "Collez ceci dans le patch du profile et redémarrez DSH. Le bloc config remplace intégralement la configuration de la ligne.",
    }
    const DICT_PT = {
      diagnostics_title: 'Estado do PowerShell 7',
      status_error: 'Falha na detecção: {error}',
      refreshed_at: 'atualizado {at}',
      status_ready: 'Pronto',
      status_denied: 'Bloqueado',
      status_detecting: 'Detectando',
      status_row_status: 'Estado',
      status_row_runtime: 'Runtime',
      status_row_path: 'Executor',
      status_no_runtime: 'PowerShell 7 não encontrado',
      status_no_path: 'Não resolvido',
      status_lead_ready: 'A ferramenta pwsh está liberada e usará o runtime abaixo.',
      status_lead_windows: 'A ferramenta pwsh está bloqueada: o executor ainda resolve para Windows PowerShell {version}.',
      status_lead_no_ps7: 'A ferramenta pwsh está bloqueada: nenhum PowerShell 7 utilizável foi encontrado.',
      status_lead_broken: 'A ferramenta pwsh está bloqueada: o executor fixa um caminho que não existe.',
      status_lead_unknown: 'Não foi possível determinar o runtime do PowerShell que o executor usará.',
      status_lead_detecting: 'Detectando o runtime do PowerShell…',
      status_note_ready: 'A ferramenta pwsh só é liberada quando o executor realmente resolve PowerShell 7 ou superior.',
      status_note_store: 'O caminho é o alias de família da Store estável em versão, então as atualizações da Store não o movem. A ativação via AppInfo não é documentada; se parar de funcionar, execute pwsh7_install ou fixe um pwsh.exe comum.',
      status_note_denied: 'Clique em “Detectar novamente” para atualizar, ou peça ao modelo para chamar pwsh7_status para obter o patch de conexão e as instruções de instalação.',
      status_note_broken: 'Substitua ou remova esse pwshPath, ou execute pwsh7_install novamente.',
      status_note_detecting: 'A primeira detecção normalmente termina rapidamente.',
      redetect: 'Detectar novamente',
      redetecting: 'Detectando…',
      star: '⭐ Achou útil? Deixe uma estrela no GitHub',
      card_title: 'Configuração',
      executor_title: 'Executor do PowerShell 7',
      executor_hint: 'O runtime que a ferramenta pwsh executa. Esta página apenas sonda e recomenda; a conexão é feita pelo patch de profile na área de status.',
      field_overridePath: 'Caminho do PowerShell 7',
      overridePath_hint: 'Caminho explícito opcional do pwsh.exe (`overridePath`). Vazio = detecção automática. Ele deve iniciar e reportar PowerShell 7 ou superior; o alias de família da Store é aceito, mas um caminho da Store numerado por versão nunca é fixado. Isso só altera o que o plugin sonda e recomenda — não conecta a ferramenta pwsh. Para isso, use o patch da área de status.',
      save: 'Salvar',
      reset: 'Redefinir',
      saved: 'Salvo {at}',
      save_rejected: 'O Host recusou a gravação.',
      form_loading: 'Carregando configuração…',
      form_unavailable: 'A configuração não está disponível agora.',
      unwritable: 'O Host não está aceitando gravações para esta linha.',
      error_remote_unavailable: 'o serviço Remote não está disponível nesta implantação',
      error_endpoint_missing: 'o endpoint de status não está montado',
      copy_patch: 'Copiar patch',
      copied: 'Copiado',
      copy_failed: 'Falha ao copiar — selecione o texto do patch e copie manualmente.',
      patch_note: 'Cole isto no patch do profile e reinicie o DSH. O bloco config substitui a configuração da linha por completo.',
    }
    const DICT_RU = {
      diagnostics_title: 'Состояние PowerShell 7',
      status_error: 'Ошибка обнаружения: {error}',
      refreshed_at: 'обновлено {at}',
      status_ready: 'Готово',
      status_denied: 'Заблокировано',
      status_detecting: 'Обнаружение',
      status_row_status: 'Состояние',
      status_row_runtime: 'Среда выполнения',
      status_row_path: 'Исполнитель',
      status_no_runtime: 'PowerShell 7 не найден',
      status_no_path: 'Не разрешён',
      status_lead_ready: 'Инструмент pwsh разрешён и будет использовать среду выполнения ниже.',
      status_lead_windows: 'Инструмент pwsh заблокирован: исполнитель всё ещё разрешает Windows PowerShell {version}.',
      status_lead_no_ps7: 'Инструмент pwsh заблокирован: рабочий PowerShell 7 не найден.',
      status_lead_broken: 'Инструмент pwsh заблокирован: исполнитель закрепляет путь, которого не существует.',
      status_lead_unknown: 'Не удалось определить среду PowerShell, которую будет использовать исполнитель.',
      status_lead_detecting: 'Обнаружение среды PowerShell…',
      status_note_ready: 'Инструмент pwsh разрешён только тогда, когда исполнитель действительно разрешает PowerShell 7 или новее.',
      status_note_store: 'Это путь семейного алиаса Store, не зависящий от версии, поэтому обновления Store его не перемещают. Активация через AppInfo не документирована; если она перестанет работать, запустите pwsh7_install или закрепите обычный pwsh.exe.',
      status_note_denied: 'Нажмите «Обнаружить снова», чтобы обновить, или попросите модель вызвать pwsh7_status для патча подключения и инструкций по установке.',
      status_note_broken: 'Замените или удалите этот pwshPath, либо снова запустите pwsh7_install.',
      status_note_detecting: 'Первое обнаружение обычно завершается быстро.',
      redetect: 'Обнаружить снова',
      redetecting: 'Обнаружение…',
      star: '⭐ Понравилось? Поставьте звезду на GitHub',
      card_title: 'Настройки',
      executor_title: 'Исполнитель PowerShell 7',
      executor_hint: 'Среда выполнения, которую запускает инструмент pwsh. Эта страница только проверяет и рекомендует; подключение выполняется патчем profile в разделе состояния.',
      field_overridePath: 'Путь к PowerShell 7',
      overridePath_hint: 'Необязательный явный путь к pwsh.exe (`overridePath`). Пусто = автообнаружение. Он должен запускаться и сообщать PowerShell 7 или новее; семейный алиас Store принимается, а путь Store с номером версии никогда не закрепляется. Это меняет только то, что плагин проверяет и рекомендует — инструмент pwsh это не подключает. Для подключения используйте патч в разделе состояния.',
      save: 'Сохранить',
      reset: 'Сбросить',
      saved: 'Сохранено {at}',
      save_rejected: 'Host отклонил запись.',
      form_loading: 'Загрузка настроек…',
      form_unavailable: 'Настройки сейчас недоступны.',
      unwritable: 'Host не принимает записи для этой строки.',
      error_remote_unavailable: 'служба Remote недоступна в этом развёртывании',
      error_endpoint_missing: 'эндпоинт состояния не смонтирован',
      copy_patch: 'Копировать патч',
      copied: 'Скопировано',
      copy_failed: 'Не удалось скопировать — выделите текст патча и скопируйте вручную.',
      patch_note: 'Вставьте это в патч profile и перезапустите DSH. Блок config полностью заменяет настройки строки.',
    }

    // One native detail-section stylesheet for both contributions. A style element only applies
    // while its section is mounted, so both sections carry it: a page can render the status
    // section without ever rendering the configure section.
    const CSS = `
.dw7-settings{display:flex;flex-direction:column;gap:12px;min-width:0;color:var(--dsw-alias-label-primary);font:inherit;}
.dw7-settings p{margin:0;line-height:1.55;overflow-wrap:anywhere;}
.dw7-group{display:flex;flex-direction:column;min-width:0;}
.dw7-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:14px;gap:10px;}
.dw7-group-head{display:flex;align-items:flex-start;gap:16px;min-width:0;}
.dw7-card .dw7-group-head{align-items:flex-start;}
.dw7-group-head .dw7-field-text{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;gap:2px;}
.dw7-group-head > button[role=switch]{flex:none;margin-top:1px;}
.dw7-group-title{margin:0 0 4px;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-secondary);}
.dw7-card .dw7-group-title{margin:0;}
.dw7-card-body{display:flex;flex-direction:column;min-width:0;padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);}
.dw7-card-body > .dw7-field{padding:10px 0;}
.dw7-card-body > .dw7-field:first-child{padding-top:0;}
.dw7-card-body > .dw7-field:last-child{padding-bottom:0;}
.dw7-card-body .dw7-field + .dw7-field{border-top:.5px solid var(--dsw-alias-border-l2);}
.dw7-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;min-width:0;}
.dw7-field + .dw7-field{border-top:.5px solid var(--dsw-alias-border-l2);}
.dw7-field-text{display:flex;flex-direction:column;flex:1 1 auto;gap:4px;min-width:0;}
.dw7-field-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary);}
.dw7-field-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);}
.dw7-input{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;}
.dw7-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary);}
.dw7-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;}
.dw7-input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary);}
.dw7-field-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);}
.dw7-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:4px;}
.dw7-save{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);}
.dw7-save:disabled{opacity:.4;cursor:default;}
.dw7-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;}
.dw7-reset:disabled{opacity:.4;cursor:default;}
.dw7-small{box-sizing:border-box;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer;}
.dw7-small:disabled{opacity:.4;cursor:not-allowed;}
.dw7-detail{display:flex;flex-direction:column;gap:12px;min-width:0;}
.dw7-detail-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;}
.dw7-detail-title{margin:0;flex:none;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);}
.dw7-detail-metric{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}
.dw7-detail-action{margin-left:auto;flex:none;}
.dw7-status-card{display:flex;flex-direction:column;gap:10px;padding:14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);min-width:0;}
.dw7-status-body{padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);min-width:0;}
.dw7-status-lead{margin:0 0 12px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6;}
.dw7-facts{display:grid;gap:6px;margin:0;}
.dw7-facts > div{display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:baseline;column-gap:14px;}
.dw7-facts dt{color:var(--dsw-alias-label-tertiary);font-size:13px;}
.dw7-facts dd{margin:0;overflow-wrap:anywhere;font-size:13px;}
.dw7-status-note{margin:12px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;}
.dw7-note{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);}
.dw7-report{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;}
.dw7-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere;}
.dw7-ok{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:1.5;}
.dw7-preview{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);font-size:13px;}
.dw7-preview-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}
.dw7-preview-note{margin:0;flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;}
.dw7-code{box-sizing:border-box;margin:0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;}
.dw7-star-section{display:flex;flex-direction:column;min-width:0;}
.dw7-star-line{margin:8px 2px 0;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}
.dw7-save:focus-visible,.dw7-reset:focus-visible,.dw7-small:focus-visible,.dw7-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;}
@media(max-width:440px){.dw7-facts > div{grid-template-columns:1fr;gap:2px;}}
`

    return {
      inject: ['slots', 'locale', 'configForms', 'remote'],
      apply(ctx) {
        // The eight official DSH locales (zh/en are built in; ja/de/es/fr/pt/ru are language
        // packs registered by @deepseek-ai/dsh-client-locale). Native convention: one dictionary
        // per official id, identical key sets — the client gate enforces parity.
        const disposeLocale = ctx.locale.register(PACKAGE, {
          zh: DICT_ZH,
          en: DICT_EN,
          ja: DICT_JA,
          de: DICT_DE,
          es: DICT_ES,
          fr: DICT_FR,
          pt: DICT_PT,
          ru: DICT_RU,
        })
        const t = ctx.locale.bind(PACKAGE)
        const form = ctx.configForms.get(ROW_ID)
        // A missing controller must not break the render, and every callback handed to
        // `useSyncExternalStore` must keep a **stable identity**: it compares snapshots with
        // `Object.is` and re-subscribes when `subscribe` changes, so a fresh object or arrow per
        // render loops forever (React: "The result of getSnapshot should be cached"). Both wrappers
        // are therefore built exactly once, here at apply time.
        const ABSENT_FORM_SUBSCRIBE = () => {}
        const ABSENT_FORM_SNAPSHOT = { status: 'unavailable', value: undefined, writable: false }
        const formSubscribe = form === undefined ? ABSENT_FORM_SUBSCRIBE : (listener) => form.subscribe(listener)
        const formSnapshot = form === undefined ? () => ABSENT_FORM_SNAPSHOT : () => form.getSnapshot()

        // ---- shared diagnostics store: one snapshot for the section and the action ----
        let snapshot = { state: 'idle', report: null, error: null, at: null, gate: null }
        const listeners = new Set()
        const diagnostics = {
          get: () => snapshot,
          subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
          set(next) {
            snapshot = next
            for (const listener of [...listeners]) listener()
          },
        }

        let mounting = null
        async function callStatus() {
          const remote = ctx.get('remote')
          if (!remote || typeof remote.$mount !== 'function') {
            throw new Error(t('error_remote_unavailable'))
          }
          if (mounting === null) {
            mounting = remote.$mount({ package: PACKAGE, descriptors: descriptorsFor(PACKAGE, ['status']) })
              .catch((error) => {
                mounting = null
                throw error
              })
          }
          await mounting
          const ns = ctx.get('remote.' + PACKAGE) || remote[PACKAGE]
          if (!ns || typeof ns.status !== 'function') {
            throw new Error(t('error_endpoint_missing'))
          }
          return unwrapRemoteResult(await ns.status({}))
        }

        async function refresh() {
          const previous = snapshot
          if (previous.state === 'loading') return
          diagnostics.set({ state: 'loading', report: previous.report, error: null, at: previous.at, gate: previous.gate })
          try {
            const out = await callStatus()
            const gate = out?.gate !== null && typeof out?.gate === 'object' ? out.gate : null
            diagnostics.set({ state: 'ready', report: typeof out?.report === 'string' ? out.report : '', error: null, at: new Date().toLocaleTimeString(), gate })
          } catch (error) {
            diagnostics.set({ state: 'error', report: previous.report, error: describe(error), at: previous.at, gate: previous.gate })
          }
        }

        // ---- components ----

        /** The profile patch a report carries, when it offers one, without the prose around it. */
        function patchFromReport(report) {
          if (typeof report !== 'string') return null
          const start = report.indexOf('- id: pwsh-sandbox')
          if (start < 0) return null
          const end = report.indexOf('\n\n', start)
          return report.slice(start, end < 0 ? undefined : end).trimEnd()
        }

        /** Map the Host gate onto the short status card: lead sentence, status facts, footnote. */
        function statusView(gate, t) {
          const reason = gate?.reasonCode
          if (gate === null || gate === undefined || gate.state === 'unknown' || reason === 'detecting') {
            return {
              status: t('status_detecting'),
              runtime: t('status_no_runtime'),
              lead: t('status_lead_detecting'),
              note: t('status_note_detecting'),
            }
          }
          if (gate.state === 'allow') {
            return {
              status: t('status_ready'),
              runtime: gate.version === undefined ? t('status_no_runtime') : `PowerShell ${gate.version}`,
              lead: t('status_lead_ready'),
              note: gate.origin === 'store-alias' ? t('status_note_store') : t('status_note_ready'),
            }
          }
          if (reason === 'windows-powershell') {
            return {
              status: t('status_denied'),
              runtime: gate.version === undefined ? t('status_no_runtime') : `Windows PowerShell ${gate.version}`,
              lead: t('status_lead_windows', { version: gate.version ?? '' }),
              note: t('status_note_denied'),
            }
          }
          if (reason === 'broken-pin') {
            return {
              status: t('status_denied'),
              runtime: t('status_no_runtime'),
              lead: t('status_lead_broken'),
              note: t('status_note_broken'),
            }
          }
          if (reason === 'no-ps7') {
            return {
              status: t('status_denied'),
              runtime: t('status_no_runtime'),
              lead: t('status_lead_no_ps7'),
              note: t('status_note_denied'),
            }
          }
          return {
            status: t('status_denied'),
            runtime: t('status_no_runtime'),
            lead: t('status_lead_unknown'),
            note: t('status_note_denied'),
          }
        }

        /** Whether a detail-page subject belongs to this plugin. */
        function isOurSubject(props) {
          const pkg = props?.subject?.pkg
          return pkg === PACKAGE || pkg?.name === PACKAGE
        }

        function DiagnosticsSection(props) {
          const active = isOurSubject(props)
          const snap = useSyncExternalStore(diagnostics.subscribe, diagnostics.get)
          const [copied, setCopied] = useState(false)
          const [copyNote, setCopyNote] = useState(null)
          useEffect(() => {
            if (active) void refresh()
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [active])
          if (!active) return null
          const report = typeof snap.report === 'string' ? snap.report : ''
          const patch = patchFromReport(report)
          const view = statusView(snap.gate, t)
          const path = typeof snap.gate?.path === 'string' && snap.gate.path !== '' ? snap.gate.path : null
          // A client half can briefly run against an older Host half (HMR or a skipped restart):
          // that Host answers only `report`, so fall back to it instead of inventing facts.
          const fallback = (snap.gate === null || snap.gate === undefined) && report !== ''
          async function copyPatch() {
            try {
              if (globalThis.navigator?.clipboard?.writeText === undefined) throw new Error('clipboard unavailable')
              await globalThis.navigator.clipboard.writeText(patch)
              setCopied(true)
              setCopyNote(null)
            } catch {
              setCopyNote(t('copy_failed'))
            }
          }
          const patchBlock = patch !== null
            ? h('div', { className: 'dw7-preview' },
              h('div', { className: 'dw7-preview-head' },
                h('p', { className: 'dw7-preview-note' }, t('patch_note')),
                h('button', { type: 'button', className: 'dw7-small', onClick: () => void copyPatch() }, copied ? t('copied') : t('copy_patch')),
                copyNote ? h('span', { className: 'dw7-error' }, copyNote) : null),
              h('pre', { className: 'dw7-code' }, patch))
            : null
          const body = fallback
            ? h('p', { className: 'dw7-report', key: 'report' }, report)
            : h('div', { className: 'dw7-status-body', key: 'body' },
              h('p', { className: 'dw7-status-lead' }, view.lead),
              h('dl', { className: 'dw7-facts' },
                h('div', { key: 'status' },
                  h('dt', null, t('status_row_status')),
                  h('dd', null, view.status)),
                h('div', { key: 'runtime' },
                  h('dt', null, t('status_row_runtime')),
                  h('dd', null, view.runtime)),
                h('div', { key: 'path' },
                  h('dt', null, t('status_row_path')),
                  h('dd', null, path ?? t('status_no_path')))),
              h('p', { className: 'dw7-status-note' }, view.note))
          return h('section', { className: 'dw7-detail' },
            h('style', null, CSS),
            h('div', { className: 'dw7-status-card' },
              h('div', { className: 'dw7-detail-head' },
                h('h3', { className: 'dw7-detail-title' }, t('diagnostics_title')),
                snap.at ? h('span', { className: 'dw7-detail-metric' }, t('refreshed_at', { at: snap.at })) : null,
                h('button', {
                  type: 'button',
                  className: 'dw7-small dw7-detail-action',
                  onClick: () => void refresh(),
                  disabled: snap.state === 'loading',
                }, snap.state === 'loading' ? t('redetecting') : t('redetect'))),
              body,
              patchBlock,
              snap.error !== null ? h('p', { className: 'dw7-error' }, t('status_error', { error: snap.error })) : null),
          )
        }

        /**
         * The dedicated bottom section for the star line. It is its own
         * `plugins.detail.section` entry (order 80, before the market source row at 90),
         * so it sits above the page's "view repository" footer and never inside the
         * status card. Other plugins' pages return null.
         */
        function StarSection(props) {
          if (!isOurSubject(props)) return null
          // `locale: PACKAGE` makes the slot inject `t`; the closure binding is the fallback
          // for an older slot implementation, so the line never falls back to a hardcoded language.
          const translate = typeof props?.t === 'function' ? props.t : t
          return h('section', { className: 'dw7-star-section' },
            h('style', null, CSS),
            h('p', { className: 'dw7-star-line', 'data-pwsh7-star': 'detail' }, translate('star')))
        }

        function ConfigureCard(props) {
          // Bound wrappers, built once at apply time: the controller's methods are class methods —
          // passing them as bare references detaches `this` and the snapshot read crashes
          // (`cannot read 'store'`) — and their identity has to stay stable across renders.
          const snap = useSyncExternalStore(formSubscribe, formSnapshot)
          const [draft, setDraft] = useState(null) // null = follow the Host snapshot
          const [busy, setBusy] = useState(false)
          const [savedAt, setSavedAt] = useState(null)
          const [note, setNote] = useState(null)

          if (props?.view === 'summary') return null

          const loading = snap.status === 'loading'
          const unavailable = snap.status === 'unavailable'
          const served = {
            overridePath: typeof snap.value?.overridePath === 'string' ? snap.value.overridePath : '',
          }
          const values = draft ?? served
          const dirty = draft !== null && values.overridePath !== served.overridePath
          const editable = !loading && !unavailable && snap.writable !== false && !busy

          async function save() {
            setBusy(true)
            setNote(null)
            try {
              let ok = true
              const nextPath = values.overridePath.trim()
              if (nextPath === '') {
                if (served.overridePath !== '') ok = await form.unset('overridePath') && ok
              } else if (nextPath !== served.overridePath) {
                ok = await form.set('overridePath', nextPath) && ok
              }
              if (ok) {
                setDraft(null)
                setSavedAt(new Date().toLocaleTimeString())
              } else {
                setNote(t('save_rejected'))
              }
            } catch (error) {
              setNote(describe(error))
            } finally {
              setBusy(false)
            }
          }

          return h('form', {
            className: 'dw7-settings',
            onSubmit: (event) => {
              event.preventDefault()
              void save()
            },
          },
            h('style', null, CSS),
            loading || unavailable
              ? h('p', { className: 'dw7-note' }, loading ? t('form_loading') : t('form_unavailable'))
              : [
                h('section', { className: 'dw7-group dw7-card', key: 'executor' },
                  h('div', { className: 'dw7-group-head' },
                    h('div', { className: 'dw7-field-text' },
                      h('h4', { className: 'dw7-group-title' }, t('executor_title')),
                      h('p', { className: 'dw7-field-hint' }, t('executor_hint')))),
                  h('div', { className: 'dw7-card-body' },
                    h('div', { className: 'dw7-field' },
                      h('label', { className: 'dw7-field-label', htmlFor: 'dw7-override-path' }, t('field_overridePath')),
                      h('input', {
                        id: 'dw7-override-path',
                        className: 'dw7-input',
                        type: 'text',
                        spellCheck: false,
                        value: values.overridePath,
                        disabled: !editable,
                        placeholder: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
                        onChange: (event) => {
                          setDraft({ ...values, overridePath: event.target.value })
                          setNote(null)
                          setSavedAt(null)
                        },
                      }),
                      h('p', { className: 'dw7-field-hint' }, t('overridePath_hint'))))),
                h('div', { className: 'dw7-actions', key: 'actions' },
                  h('button', {
                    type: 'submit',
                    className: 'dw7-save',
                    disabled: !editable || (!dirty && note === null),
                  }, t('save')),
                  h('button', {
                    type: 'button',
                    className: 'dw7-reset',
                    onClick: () => {
                      setDraft(null)
                      setNote(null)
                      setSavedAt(null)
                    },
                    disabled: !editable || (!dirty && note === null),
                  }, t('reset')),
                  snap.writable === false ? h('span', { className: 'dw7-error' }, t('unwritable')) : null,
                  savedAt ? h('span', { className: 'dw7-ok' }, t('saved', { at: savedAt })) : null,
                  note ? h('span', { className: 'dw7-error' }, note) : null),
              ],
          )
        }

        // ---- registrations (alive while the row is enabled; disposed with the fiber) ----
        ctx.effect(() => disposeLocale, 'dsh-win-pwsh7: client locale namespace')
        ctx.effect(() => {
          // The star line is optional chrome: if an older/foreign host rejects the extra
          // section, the settings card and the status section must still register.
          const injectStar = () => {
            try {
              return ctx.slots.inject('plugins.detail.section', () => {
                try {
                  return ctx.slots.register({
                    name: 'plugins.detail.section',
                    id: PACKAGE + '.star',
                    order: 80,
                    locale: PACKAGE,
                  }, StarSection)
                } catch {
                  return () => {}
                }
              })
            } catch {
              return () => {}
            }
          }
          const disposers = [
            ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
              name: 'plugins.row.config',
              key: SLOT_KEY,
              locale: PACKAGE,
            }, ConfigureCard)),
            ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
              name: 'plugins.detail.section',
              id: PACKAGE + '.diagnostics',
              order: 50,
              locale: PACKAGE,
            }, DiagnosticsSection)),
            // Its own section, at 80: below diagnostics(50) and above the market source(90),
            // which renders the page footer's "view repository" row.
            injectStar(),
          ]
          return () => {
            for (const dispose of disposers) dispose?.()
          }
        }, 'dsh-win-pwsh7: plugin page sections')
      },
    }
  },
})

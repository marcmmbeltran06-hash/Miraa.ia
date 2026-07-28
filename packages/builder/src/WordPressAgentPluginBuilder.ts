/**
 * Generates the local WordPress plugin used by AutoWP reconstructions.
 * It deliberately accepts a small, auditable operation language instead of
 * executing prompts or arbitrary files on the WordPress host.
 */
export class WordPressAgentPluginBuilder {
  public pluginPhp(): string {
    return String.raw`<?php
/*
Plugin Name: AutoWP WordPress Agent
Description: Safe, preview-first HTML and WooCommerce operations for AutoWP.
Version: 1.1.0
*/
defined('ABSPATH') || exit;

final class AutoWP_WordPress_Agent {
  const REST = 'autowp-agent/v1';
  const TRANSIENT_PREFIX = 'autowp_agent_preview_';
  const MAX_HTML_BYTES = 2097152;
  const ALLOWED = array('create_page_from_html','update_page_from_html','append_html_to_page','prepend_html_to_page','replace_component','insert_component_before','insert_component_after','create_template_from_html','create_product_from_html','create_products_from_html','update_product_from_html','create_variable_product','import_media','import_styles','import_script','create_menu','update_menu','convert_to_editable_blocks','add_image','improve_product_copy','optimize_product_layout','update_seo');

  public static function init() {
    add_action('init', array(__CLASS__, 'register_types'));
    add_action('rest_api_init', array(__CLASS__, 'routes'));
    add_action('admin_menu', array(__CLASS__, 'menu'));
    add_action('admin_bar_menu', array(__CLASS__, 'bar'), 90);
    add_action('admin_enqueue_scripts', array(__CLASS__, 'assets'));
  }

  public static function register_types() {
    register_post_type('autowp_agent_log', array('label' => 'AutoWP Agent history', 'public' => false, 'show_ui' => false, 'supports' => array('title','editor','custom-fields')));
  }
  public static function can_manage() { return current_user_can('edit_pages') && current_user_can('upload_files'); }
  public static function permission() { return self::can_manage(); }
  public static function menu() { add_menu_page('AutoWP Agent', 'AutoWP', 'edit_pages', 'autowp-agent', array(__CLASS__, 'screen'), 'dashicons-superhero-alt', 57); }
  public static function bar($bar) { if (self::can_manage()) $bar->add_node(array('id'=>'autowp-agent','title'=>'Editar con AutoWP','href'=>admin_url('admin.php?page=autowp-agent'))); }
  public static function assets($hook) {
    if ($hook !== 'toplevel_page_autowp-agent') return;
    wp_enqueue_script('autowp-agent-admin', plugins_url('admin.js', __FILE__), array('wp-api-fetch'), '1.0.0', true);
    wp_localize_script('autowp-agent-admin', 'AutoWPAgent', array('root'=>esc_url_raw(rest_url(self::REST . '/')), 'nonce'=>wp_create_nonce('wp_rest')));
    wp_enqueue_style('autowp-agent-admin', plugins_url('admin.css', __FILE__), array(), '1.0.0');
  }
  public static function screen() { ?>
    <div class="wrap autowp-agent"><h1>AutoWP · Agente IA</h1>
    <p>El agente prepara una operación segura. Nada se publica hasta pulsar <em>Aplicar</em>.</p>
    <div class="autowp-agent-grid"><section><label>Instrucción<textarea id="autowp-instruction" rows="3" placeholder="Sube este HTML como una página nueva"></textarea></label>
    <label>Operación <select id="autowp-operation"><option value="auto">Detectar desde la instrucción</option><?php foreach (self::ALLOWED as $op) echo '<option value="' . esc_attr($op) . '">' . esc_html($op) . '</option>'; ?></select></label>
    <label>Página/producto objetivo (ID) <input id="autowp-target" type="number" min="1"></label>
    <label>Título <input id="autowp-title" type="text"></label><label>Slug <input id="autowp-slug" type="text"></label>
    <label>Estado <select id="autowp-status"><option value="draft">Borrador</option><option value="publish">Publicar tras aplicar</option></select></label>
    <label>HTML<textarea id="autowp-html" rows="14" placeholder="Pega HTML aquí"></textarea></label>
    <label>Archivo HTML <input id="autowp-file" type="file" accept=".html,.htm,text/html"></label>
    <p><button class="button button-primary" id="autowp-plan">Generar vista previa</button> <button class="button" id="autowp-apply" disabled>Aplicar</button></p></section>
    <section><h2>Vista previa</h2><div id="autowp-preview">Aún no hay operación preparada.</div><h2>Historial</h2><div id="autowp-history"></div></section></div></div>
  <?php }

  public static function routes() {
    $auth = array('permission_callback'=>array(__CLASS__, 'permission'));
    register_rest_route(self::REST, '/capabilities', array_merge($auth, array('methods'=>'GET','callback'=>array(__CLASS__,'rest_capabilities'))));
    register_rest_route(self::REST, '/content', array_merge($auth, array('methods'=>'GET','callback'=>array(__CLASS__,'rest_content'))));
    register_rest_route(self::REST, '/content/(?P<id>\\d+)', array_merge($auth, array('methods'=>'GET','callback'=>array(__CLASS__,'rest_content_item'))));
    register_rest_route(self::REST, '/plan', array_merge($auth, array('methods'=>'POST','callback'=>array(__CLASS__,'rest_plan'))));
    register_rest_route(self::REST, '/preview', array_merge($auth, array('methods'=>'POST','callback'=>array(__CLASS__,'rest_preview'))));
    register_rest_route(self::REST, '/apply', array_merge($auth, array('methods'=>'POST','callback'=>array(__CLASS__,'rest_apply'))));
    register_rest_route(self::REST, '/rollback', array_merge($auth, array('methods'=>'POST','callback'=>array(__CLASS__,'rest_rollback'))));
    register_rest_route(self::REST, '/history', array_merge($auth, array('methods'=>'GET','callback'=>array(__CLASS__,'rest_history'))));
    register_rest_route(self::REST, '/import-html', array_merge($auth, array('methods'=>'POST','callback'=>array(__CLASS__,'rest_import_html'))));
    register_rest_route(self::REST, '/import-products', array_merge($auth, array('methods'=>'POST','callback'=>array(__CLASS__,'rest_plan'))));
  }

  public static function rest_capabilities() {
    return rest_ensure_response(array(
      'version'=>'1.1.0',
      'previewFirst'=>true,
      'explicitApply'=>true,
      'rollback'=>true,
      'operations'=>self::ALLOWED,
      'seoNotice'=>'SEO changes are technical/content improvements and never guarantee a ranking increase.',
    ));
  }
  public static function rest_content($request) {
    $kind=sanitize_key($request->get_param('kind') ?: 'page');
    $post_type=$kind==='product' ? 'product' : 'page';
    $per_page=max(1,min(100,absint($request->get_param('per_page') ?: 20)));
    $page=max(1,absint($request->get_param('page') ?: 1));
    $query=new WP_Query(array('post_type'=>$post_type,'post_status'=>array('publish','draft','private','pending'),'posts_per_page'=>$per_page,'paged'=>$page,'s'=>sanitize_text_field($request->get_param('search') ?: ''),'orderby'=>'modified','order'=>'DESC'));
    $items=array_map(function($post) use ($post_type) {
      $item=array('id'=>$post->ID,'type'=>$post_type,'title'=>get_the_title($post),'slug'=>$post->post_name,'status'=>$post->post_status,'modified'=>$post->post_modified_gmt,'url'=>get_permalink($post));
      if($post_type==='product' && function_exists('wc_get_product')) { $product=wc_get_product($post->ID); if($product){$item['sku']=$product->get_sku();$item['price']=$product->get_price();$item['stockStatus']=$product->get_stock_status();} }
      return $item;
    },$query->posts);
    return rest_ensure_response(array('items'=>$items,'page'=>$page,'pages'=>(int)$query->max_num_pages,'total'=>(int)$query->found_posts));
  }
  public static function rest_content_item($request) {
    $id=absint($request['id']); $post=get_post($id);
    if(!$post || !in_array($post->post_type,array('page','product'),true)) return new WP_Error('autowp_content_missing','Page or product not found.',array('status'=>404));
    $item=array('id'=>$id,'type'=>$post->post_type,'title'=>get_the_title($post),'slug'=>$post->post_name,'status'=>$post->post_status,'url'=>get_permalink($post),'content'=>self::page_html($id),'excerpt'=>$post->post_excerpt,'editableBlocks'=>has_blocks($post->post_content),'seo'=>array('title'=>(string)get_post_meta($id,'_autowp_seo_title',true),'description'=>(string)get_post_meta($id,'_autowp_seo_description',true)));
    if($post->post_type==='product' && function_exists('wc_get_product')) { $product=wc_get_product($id); if($product)$item['product']=array('name'=>$product->get_name(),'sku'=>$product->get_sku(),'description'=>$product->get_description(),'shortDescription'=>$product->get_short_description(),'price'=>$product->get_price(),'stockStatus'=>$product->get_stock_status(),'imageId'=>$product->get_image_id(),'galleryImageIds'=>$product->get_gallery_image_ids()); }
    return rest_ensure_response($item);
  }

  private static function request($request) {
    $data = $request->get_json_params(); if (!is_array($data)) $data = $request->get_params();
    $files = $request->get_file_params();
    if (isset($files['html_file']) && is_array($files['html_file']) && ($files['html_file']['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_OK) {
      $file = $files['html_file'];
      if ((int)($file['size'] ?? 0) > self::MAX_HTML_BYTES) return new WP_Error('autowp_upload_too_large', 'Uploaded HTML/ZIP exceeds the 2 MB safety limit.', array('status'=>413));
      $name = sanitize_file_name($file['name'] ?? 'import.html');
      if (preg_match('/\.zip$/i', $name)) {
        require_once ABSPATH . 'wp-admin/includes/file.php';
        $tmp = trailingslashit(get_temp_dir()) . 'autowp-agent-' . wp_generate_uuid4();
        if (!wp_mkdir_p($tmp) || unzip_file($file['tmp_name'], $tmp) !== true) return new WP_Error('autowp_zip_invalid', 'The ZIP could not be safely unpacked.', array('status'=>422));
        $matches = glob($tmp . '/{index,home}*.{html,htm}', GLOB_BRACE);
        if (!$matches) $matches = glob($tmp . '/**/*.{html,htm}', GLOB_BRACE);
        if (!$matches) return new WP_Error('autowp_html_missing', 'The ZIP does not contain an HTML file.', array('status'=>422));
        $data['html'] = file_get_contents($matches[0]);
        $data['uploadName'] = $name;
      } else {
        $data['html'] = file_get_contents($file['tmp_name']);
      }
    }
    $html = isset($data['html']) ? (string) $data['html'] : '';
    if (strlen($html) > self::MAX_HTML_BYTES) return new WP_Error('autowp_html_too_large', 'HTML exceeds the 2 MB safety limit.', array('status'=>413));
    return $data;
  }
  public static function rest_import_html($request) { return self::rest_plan($request); }
  private static function operation($instruction, $requested) {
    if (in_array($requested, self::ALLOWED, true)) return $requested;
    $text = strtolower((string)$instruction);
    if (preg_match('/producto.*variable|variable.*producto/', $text)) return 'create_variable_product';
    if (preg_match('/productos|fichas/', $text)) return 'create_products_from_html';
    if (preg_match('/producto/', $text)) return 'create_product_from_html';
    if (preg_match('/antes del footer|append|a[ñn]ade esta secci[óo]n/', $text)) return 'append_html_to_page';
    if (preg_match('/antes de|prepend/', $text)) return 'prepend_html_to_page';
    if (preg_match('/sustituye|reemplaza|actualiza/', $text)) return 'update_page_from_html';
    return 'create_page_from_html';
  }
  private static function safe_html($html) {
    $html = preg_replace('/<\/?(?:html|head|body)\b[^>]*>/i', '', (string)$html);
    $html = preg_replace('/<\?(?:php|=)[\s\S]*?\?>/i', '', $html);
    $html = preg_replace('/\son\w+\s*=\s*(["\']).*?\1/i', '', $html);
    return wp_kses($html, wp_kses_allowed_html('post'));
  }
  private static function classify_scripts($html) {
    $blocked = array();
    foreach (self::extract_tags($html, 'script') as $script) {
      if (preg_match('/\beval\s*\(|<\?php|\bexec\s*\(|\bshell_exec\s*\(/i', $script)) $blocked[] = 'Unsafe script removed';
      elseif (preg_match('/\bsrc=(?:"|\')(https?:\/\/[^"\']+)/i', $script)) $blocked[] = 'Remote script requires explicit local import';
    }
    return array_values(array_unique($blocked));
  }
  private static function extract_tags($html, $tag) { preg_match_all('/<' . preg_quote($tag, '/') . '\b[^>]*>[\s\S]*?<\/' . preg_quote($tag, '/') . '>/i', $html, $m); return $m[0] ?? array(); }
  private static function split_assets($html) {
    preg_match_all('/<style\b[^>]*>([\s\S]*?)<\/style>/i', $html, $styles);
    $html = preg_replace('/<style\b[^>]*>[\s\S]*?<\/style>/i', '', $html);
    $html = preg_replace('/<script\b[\s\S]*?<\/script>/i', '', $html);
    return array($html, $styles[1] ?? array());
  }
  private static function scope_css($css, $scope) {
    $rules = preg_split('/(?<=\})/', (string)$css); $out = array();
    foreach ($rules as $rule) {
      if (!str_contains($rule, '{') || preg_match('/^\s*@(?:media|keyframes|font-face)/i', $rule)) { $out[] = $rule; continue; }
      [$selectors, $body] = explode('{', $rule, 2);
      $selectors = implode(',', array_map(function($s) use ($scope) { $s=trim($s); return $s === '' ? '' : $scope . ' ' . $s; }, explode(',', $selectors)));
      $out[] = $selectors . '{' . $body;
    }
    return implode("\n", $out);
  }
  private static function page_html($post_id) {
    $override = get_post_meta($post_id, '_autowp_agent_html_override', true);
    return $override !== '' ? (string)$override : (string)get_post_field('post_content', $post_id);
  }
  private static function preview_id() { return self::TRANSIENT_PREFIX . get_current_user_id() . '_' . wp_generate_uuid4(); }

  public static function rest_plan($request) {
    $data = self::request($request); if (is_wp_error($data)) return $data;
    $operation = self::operation($data['instruction'] ?? '', $data['operation'] ?? '');
    $target = absint($data['targetId'] ?? $data['pageId'] ?? 0);
    $html = (string)($data['html'] ?? ''); list($body, $styles) = self::split_assets($html);
    $warnings = self::classify_scripts($html);
    if (!$body && !in_array($operation, array('create_menu','update_menu'), true)) $warnings[] = 'No HTML was supplied.';
    if (str_contains($html, '<?')) $warnings[] = 'PHP was removed.';
    if ($target && !get_post($target)) return new WP_Error('autowp_target_missing', 'Target page or product does not exist.', array('status'=>404));
    $plan = array('id'=>self::preview_id(),'operation'=>$operation,'instruction'=>sanitize_textarea_field($data['instruction'] ?? ''),'targetId'=>$target,'title'=>sanitize_text_field($data['title'] ?? ''),'slug'=>sanitize_title($data['slug'] ?? ''),'status'=>in_array(($data['status'] ?? 'draft'),array('draft','publish'),true) ? $data['status'] : 'draft','html'=>self::safe_html($body),'css'=>array_values(array_filter(array_map('wp_strip_all_tags',$styles))),'media'=>array_values(array_map('esc_url_raw',(array)($data['media'] ?? array()))),'scripts'=>array_values(array_filter(array_map('sanitize_textarea_field',(array)($data['scripts'] ?? array())))),'menuName'=>sanitize_text_field($data['menuName'] ?? ''),'menuItems'=>array_values((array)($data['menuItems'] ?? array())),'warnings'=>$warnings,'createdAt'=>time(),'userId'=>get_current_user_id());
    if (str_contains($operation, 'product')) $plan['products'] = self::extract_products($plan['html']);
    set_transient($plan['id'], $plan, HOUR_IN_SECONDS);
    return rest_ensure_response(array('plan'=>$plan,'preview'=>self::preview($plan)));
  }
  public static function rest_preview($request) { return self::rest_plan($request); }
  private static function preview($plan) { return array('affectedPages'=>!empty($plan['targetId']) ? array($plan['targetId']) : array(), 'products'=>count($plan['products'] ?? array()), 'styles'=>count($plan['css'] ?? array()), 'warnings'=>$plan['warnings'] ?? array(), 'html'=>wp_kses_post($plan['html'] ?? '')); }

  public static function rest_apply($request) {
    $data = self::request($request); if (is_wp_error($data)) return $data;
    $id = sanitize_text_field($data['planId'] ?? ''); $plan = get_transient($id);
    if (!is_array($plan) || ($plan['userId'] ?? 0) !== get_current_user_id()) return new WP_Error('autowp_plan_expired', 'Preview expired. Generate a new preview.', array('status'=>410));
    $result = self::apply($plan); if (is_wp_error($result)) return $result;
    delete_transient($id); return rest_ensure_response($result);
  }
  private static function apply($plan) {
    $op=$plan['operation']; $before=array(); $affected=array(); $result=array(); $warnings=$plan['warnings'] ?? array();
    if (in_array($op, array('create_menu','update_menu'), true)) {
      $name = $plan['menuName'] ?: ($plan['title'] ?: 'AutoWP Menu'); $menu = wp_get_nav_menu_object($name); $menu_id = $menu ? (int)$menu->term_id : (int)wp_create_nav_menu($name); if (!$menu_id) return new WP_Error('autowp_menu_failed','Unable to create menu.',array('status'=>500));
      foreach ((array)($plan['menuItems'] ?? array()) as $item) { if (!is_array($item)) continue; $label=sanitize_text_field($item['label']??$item['title']??'Link'); $url=esc_url_raw($item['url']??home_url('/')); wp_update_nav_menu_item($menu_id,0,array('menu-item-title'=>$label,'menu-item-url'=>$url,'menu-item-status'=>'publish')); }
      $result=array('menuId'=>$menu_id);
    } elseif ($op === 'import_styles') {
      if (!$plan['targetId']) return new WP_Error('autowp_page_required','Select a page for scoped styles.',array('status'=>422)); self::save_scoped_styles($plan['targetId'],$plan['css']); $result=array('pages'=>array($plan['targetId']));
    } elseif ($op === 'import_script') {
      if (!$plan['targetId']) return new WP_Error('autowp_page_required','Select a page for scripts.',array('status'=>422)); update_post_meta($plan['targetId'],'_autowp_agent_scripts',array_values($plan['scripts'] ?? array())); $result=array('pages'=>array($plan['targetId']));
    } elseif ($op === 'import_media') {
      require_once ABSPATH . 'wp-admin/includes/media.php'; require_once ABSPATH . 'wp-admin/includes/file.php'; require_once ABSPATH . 'wp-admin/includes/image.php'; $ids=array(); foreach ((array)($plan['media'] ?? array()) as $url) { $id=media_sideload_image(esc_url_raw($url),absint($plan['targetId']),null,'id'); if (!is_wp_error($id)) $ids[]=(int)$id; else $warnings[]=$id->get_error_message(); } $result=array('media'=>$ids,'warnings'=>$warnings);
    } elseif (str_contains($op, 'product')) {
      if (!class_exists('WC_Product_Simple')) return new WP_Error('autowp_woocommerce_missing','WooCommerce is not active.',array('status'=>409));
      $items=$plan['products'] ?? self::extract_products($plan['html']); if (!$items) return new WP_Error('autowp_products_missing','No product records were detected in the HTML.',array('status'=>422));
      foreach ($items as $item) { $product=self::upsert_product($item, $op === 'create_variable_product'); if (is_wp_error($product)) return $product; $affected[]=$product->get_id(); }
      $result=array('products'=>$affected);
    } else {
      $target=absint($plan['targetId']); $html=$plan['html'];
      if ($op === 'create_page_from_html' || $op === 'create_template_from_html') {
        $target=wp_insert_post(array('post_type'=>'page','post_status'=>$plan['status'],'post_title'=>$plan['title'] ?: 'Imported page','post_name'=>$plan['slug'],'post_content'=>$html), true);
        if (is_wp_error($target)) return $target; $affected[]=$target;
      } else {
        if (!$target || get_post_type($target) !== 'page') return new WP_Error('autowp_page_required','Select a valid page target.',array('status'=>422));
        $old=self::page_html($target); $before[$target]=array('html'=>$old,'override'=>(string)get_post_meta($target,'_autowp_agent_html_override',true));
        if ($op === 'append_html_to_page' || $op === 'insert_component_before') $html=$old . $html;
        elseif ($op === 'prepend_html_to_page' || $op === 'insert_component_after') $html=$html . $old;
        elseif ($op === 'replace_component') $html=self::replace_component($old,$html,$plan['targetSelector'] ?? '');
        // Reconstructed pages are rendered from their source template. Store
        // an explicit override so an agent edit is visible without destroying
        // the original static replica and can be rolled back independently.
        update_post_meta($target, '_autowp_agent_html_override', $html);
        wp_update_post(array('ID'=>$target,'post_status'=>$plan['status'])); $affected[]=$target;
      }
      self::save_scoped_styles($target, $plan['css']); $result=array('pages'=>$affected);
    }
    $log=wp_insert_post(array('post_type'=>'autowp_agent_log','post_status'=>'private','post_title'=>'AutoWP ' . $op . ' ' . current_time('mysql'),'post_content'=>wp_slash(wp_json_encode(array('plan'=>$plan,'before'=>$before,'affected'=>$affected,'result'=>$result),JSON_PRETTY_PRINT))));
    return array_merge(array('applied'=>true,'operation'=>$op,'historyId'=>$log,'rollbackAvailable'=>true),$result);
  }
  private static function replace_component($old,$replacement,$target) {
    $target=trim((string)$target); if ($target === '') return $replacement;
    if (preg_match("~^\\[data-autowp-id=[\"']?([^\\]\"']+)[\"']?\\]$~", $target,$m)) return preg_replace("~<([\\w:-]+)\\b[^>]*data-autowp-id=([\"'])" . preg_quote($m[1],'~') . "\\2[^>]*>[\\s\\S]*?<\\/\\1>~i",$replacement,$old,1) ?? $old;
    if (preg_match("~^#([\\w-]+)$~",$target,$m)) return preg_replace("~<([\\w:-]+)\\b[^>]*\\bid=([\"'])" . preg_quote($m[1],'~') . "\\2[^>]*>[\\s\\S]*?<\\/\\1>~i",$replacement,$old,1) ?? $old;
    return $replacement;
  }
  private static function save_scoped_styles($post_id,$styles) { if (!$post_id || !$styles) return; $scope='.page-id-' . absint($post_id); update_post_meta($post_id,'_autowp_agent_css',implode("\n",array_map(function($css)use($scope){return self::scope_css($css,$scope);},$styles))); update_post_meta($post_id,'_autowp_agent_scope',$scope); }
  public static function render_css() { if (!is_singular()) return; $id=get_queried_object_id(); $css=get_post_meta($id,'_autowp_agent_css',true); if ($css) echo '<style id="autowp-agent-page-css">' . $css . '</style>'; }

  private static function extract_products($html) {
    $items=array();
    if (preg_match_all('/<script\\b[^>]*type=["\\\']application\\/ld\\+json["\\\'][^>]*>(.*?)<\\/script>/is',$html,$scripts)) foreach($scripts[1] as $raw){$json=json_decode(trim($raw),true);$records=isset($json['@graph'])?$json['@graph']:array($json);foreach($records as $r){if(!is_array($r))continue;$types=(array)($r['@type']??array());if(($r['@type']??'')!=='Product'&&!in_array('Product',$types,true))continue;$offers=$r['offers']??array();$price=is_array($offers)&&isset($offers['price'])?$offers['price']:'';$items[]=array('name'=>$r['name']??'Product','description'=>$r['description']??'','sku'=>$r['sku']??'','price'=>$price,'image'=>is_array($r['image']??null)?reset($r['image']):($r['image']??''));}}
    if (!$items && preg_match_all("~<(?:article|li|div)\\b[^>]*class=([\"'])[^\"']*\\bproduct\\b[^\"']*\\1[^>]*>([\\s\\S]*?)<\\/(?:article|li|div)>~i",$html,$cards,PREG_SET_ORDER)) foreach($cards as $card){$text=wp_strip_all_tags($card[2]);preg_match("~<[^>]*class=([\"'])[^\"']*(?:title|name)[^\"']*\\1[^>]*>([\\s\\S]*?)<\\/~i",$card[2],$title);preg_match('~(?:€|\\$|£)\\s*([0-9]+(?:[.,][0-9]{2})?)~',$text,$price);$items[]=array('name'=>wp_strip_all_tags($title[2]??'Product'),'price'=>str_replace(',','.',$price[1]??''),'description'=>$text,'sku'=>'');}
    return array_values(array_filter($items,function($p){return !empty($p['name']);}));
  }
  private static function upsert_product($item,$variable=false) { $sku=sanitize_text_field($item['sku']??''); $id=$sku?wc_get_product_id_by_sku($sku):0; $product=$id?wc_get_product($id):($variable?new WC_Product_Variable():new WC_Product_Simple()); if(!$product)return new WP_Error('autowp_product_failed','Unable to create product.'); $product->set_name(sanitize_text_field($item['name']??'Product')); if($sku)$product->set_sku($sku); $product->set_description(wp_kses_post($item['description']??'')); if(isset($item['price'])&&is_numeric(str_replace(',','.',$item['price'])))$product->set_regular_price(str_replace(',','.',$item['price'])); $product->set_status('draft'); $product->save(); if($variable&&!empty($item['variants'])&&is_array($item['variants'])){foreach($item['variants'] as $variant){if(!is_array($variant))continue;$variation=new WC_Product_Variation();$variation->set_parent_id($product->get_id());$vsku=sanitize_text_field($variant['sku']??'');if($vsku&&!wc_get_product_id_by_sku($vsku))$variation->set_sku($vsku);$vprice=$variant['price']??'';if(is_numeric(str_replace(',','.',$vprice)))$variation->set_regular_price(str_replace(',','.',$vprice));$attrs=array();foreach((array)($variant['attributes']??array()) as $key=>$value)$attrs[sanitize_title($key)]=sanitize_title($value);if($attrs)$variation->set_attributes($attrs);$variation->set_status('draft');$variation->save();}} return $product; }
  public static function rest_rollback($request) {
    $request_data=self::request($request); if(is_wp_error($request_data))return $request_data;
    $log=get_post(absint($request_data['historyId']??0));
    if(!$log||$log->post_type!=='autowp_agent_log')return new WP_Error('autowp_history_missing','History record not found.',array('status'=>404));
    $record=json_decode($log->post_content,true);
    if(!is_array($record))return new WP_Error('autowp_history_invalid','History record is invalid and cannot be rolled back safely.',array('status'=>500));
    $restored=array(); $failed=array();
    foreach(($record['before']??array()) as $id=>$snapshot){
      $id=absint($id); $old=is_array($snapshot)?(string)($snapshot['html']??''):(string)$snapshot;
      $updated=wp_update_post(array('ID'=>$id,'post_content'=>$old),true);
      if(is_wp_error($updated)){ $failed[$id]=$updated->get_error_message(); continue; }
      $expected_override=is_array($snapshot)?(string)($snapshot['override']??''):'';
      delete_post_meta($id,'_autowp_agent_html_override');
      if($expected_override!=='')update_post_meta($id,'_autowp_agent_html_override',$expected_override);
      clean_post_cache($id); wp_cache_delete($id,'post_meta');
      $actual_override=(string)get_post_meta($id,'_autowp_agent_html_override',true);
      if($actual_override!==$expected_override){ $failed[$id]='The page override was not restored.'; continue; }
      $restored[]=$id;
    }
    if($failed)return new WP_Error('autowp_rollback_failed','Rollback verification failed.',array('status'=>500,'pages'=>$failed));
    update_post_meta($log->ID,'_autowp_rolled_back',current_time('mysql'));
    return array('rolledBack'=>true,'verified'=>true,'pages'=>$restored);
  }
  public static function rest_history() { $logs=get_posts(array('post_type'=>'autowp_agent_log','post_status'=>'private','posts_per_page'=>30)); return array_map(function($log){return array('id'=>$log->ID,'title'=>$log->post_title,'date'=>$log->post_date,'rolledBack'=>(bool)get_post_meta($log->ID,'_autowp_rolled_back',true));},$logs); }
}
AutoWP_WordPress_Agent::init();
add_action('wp_head', array('AutoWP_WordPress_Agent','render_css'), 99);
add_action('wp_footer', function() { if (!is_singular()) return; foreach ((array)get_post_meta(get_queried_object_id(), '_autowp_agent_scripts', true) as $script) { $script=(string)$script; if ($script!=='' && !preg_match('/\beval\s*\(|\b(?:exec|shell_exec|system)\s*\(/i',$script)) echo '<script>' . $script . '</script>'; } }, 98);
`;
  }

  public adminJs(): string {
    return String.raw`(function () {
const $ = (s) => document.querySelector(s); let planId = null;
const request = async (path, options) => { const isForm = options.body instanceof FormData; const headers = { 'X-WP-Nonce':AutoWPAgent.nonce, ...(options.headers || {}) }; if (!isForm) headers['Content-Type']='application/json'; const r = await fetch(AutoWPAgent.root + path, { ...options, headers }); const data = await r.json(); if (!r.ok) throw new Error(data.message || 'Request failed'); return data; };
const payload = () => ({ instruction: $('#autowp-instruction').value, operation: $('#autowp-operation').value, targetId: $('#autowp-target').value, title: $('#autowp-title').value, slug: $('#autowp-slug').value, status: $('#autowp-status').value, html: $('#autowp-html').value });
const history = async () => { const items = await request('history', { method:'GET' }); $('#autowp-history').innerHTML = items.map(x => '<p><strong>'+x.title+'</strong><br><button data-rollback="'+x.id+'" '+(x.rolledBack?'disabled':'')+'>Deshacer</button></p>').join('') || '<p>Sin operaciones.</p>'; document.querySelectorAll('[data-rollback]').forEach(b => b.onclick = async () => { if (!confirm('¿Restaurar el contenido anterior?')) return; await request('rollback',{method:'POST',body:JSON.stringify({historyId:b.dataset.rollback})}); history(); }); };
let selectedFile = null;
$('#autowp-file').onchange = async (e) => { const f=e.target.files[0]; selectedFile=f || null; if (f && /\.zip$/i.test(f.name)) { $('#autowp-preview').textContent='ZIP seleccionado. Pulsa Generar vista previa para importarlo de forma segura.'; return; } if (f) $('#autowp-html').value=await f.text(); };
$('#autowp-plan').onclick = async () => { try { const r=await request('plan',{method:'POST',body:JSON.stringify(payload())}); planId=r.plan.id; $('#autowp-apply').disabled=false; $('#autowp-preview').innerHTML='<p><strong>'+r.plan.operation+'</strong></p><p>Páginas afectadas: '+r.preview.affectedPages.join(', ')+'</p><p>Productos: '+r.preview.products+' · Estilos: '+r.preview.styles+'</p><pre>'+r.preview.warnings.join('\n')+'</pre><iframe sandbox srcdoc="'+r.preview.html.replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'"></iframe>'; } catch(e) { $('#autowp-preview').textContent=e.message; } };
$('#autowp-apply').onclick = async () => { if (!planId || !confirm('¿Aplicar esta operación?')) return; try { const r=await request('apply',{method:'POST',body:JSON.stringify({planId})}); $('#autowp-preview').textContent='Aplicado. Historial #'+r.historyId; $('#autowp-apply').disabled=true; planId=null; history(); } catch(e) { $('#autowp-preview').textContent=e.message; } };
history();
})();`;
  }

  public adminCss(): string {
    return '.autowp-agent-grid{display:grid;grid-template-columns:minmax(320px,1fr) minmax(320px,1fr);gap:24px;max-width:1400px}.autowp-agent label{display:block;font-weight:600;margin:12px 0}.autowp-agent textarea,.autowp-agent input,.autowp-agent select{display:block;width:100%;max-width:100%;margin-top:5px}.autowp-agent #autowp-preview{background:#fff;border:1px solid #ccd0d4;padding:16px;min-height:160px}.autowp-agent iframe{width:100%;height:300px;border:1px solid #ccd0d4;background:#fff}@media(max-width:900px){.autowp-agent-grid{grid-template-columns:1fr}}';
  }
}

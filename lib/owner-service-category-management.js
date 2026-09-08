'use strict';

class OwnerServiceCategoryError extends Error {
  constructor(code, status, message) {
    super(code); this.code = code; this.status = status; this.publicMessage = message;
  }
}

const FIELDS = new Set(['canonicalName', 'nameZh', 'nameEn', 'iconKey', 'sortOrder', 'isActive']);
const cleanText = (value, max, required = false) => {
  if (value === null && !required) return null;
  if (typeof value !== 'string') return undefined;
  const result = value.trim();
  return (!result || result.length > max) ? undefined : result;
};

const validate = (body, partial) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '分类资料格式不正确' };
  const keys = Object.keys(body);
  if (!keys.length || keys.some(key => !FIELDS.has(key))) return { error: '包含不支持的分类字段' };
  const values = {};
  for (const field of ['canonicalName', 'nameZh', 'nameEn']) {
    if (!keys.includes(field)) continue;
    const value = cleanText(body[field], 200, true);
    if (!value) return { error: '分类名称不能为空' };
    values[field] = value;
  }
  if (!partial && !values.canonicalName && !values.nameEn && !values.nameZh) return { error: '分类名称不能为空' };
  if (keys.includes('iconKey')) {
    const value = cleanText(body.iconKey, 100);
    if (body.iconKey !== null && !value) return { error: '分类图标格式不正确' };
    values.iconKey = value;
  }
  if (keys.includes('sortOrder')) {
    if (!Number.isInteger(body.sortOrder) || body.sortOrder < 0 || body.sortOrder > 1000000000) return { error: '分类排序值不正确' };
    values.sortOrder = body.sortOrder;
  }
  if (keys.includes('isActive')) {
    if (typeof body.isActive !== 'boolean') return { error: '分类状态格式不正确' };
    values.isActive = body.isActive;
  }
  return { values };
};

const resolveCategoryName = (category, locale) => {
  const normalized = typeof locale === 'string' && locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  return normalized === 'zh-CN'
    ? category.nameZh || category.nameEn || category.canonicalName
    : category.nameEn || category.nameZh || category.canonicalName;
};

const createOwnerServiceCategoryManagement = ({ pool, isUuid, runInTransaction, safeErrorCode }) => {
  const select = async (client, shopId, categoryId = null) => (await client.query(`
    SELECT category.id, category.canonical_name AS "canonicalName",
      category.icon_key AS "iconKey", category.sort_order AS "sortOrder",
      category.is_active AS "isActive", category.created_at AS "createdAt",
      category.updated_at AS "updatedAt", zh.name AS "nameZh", en.name AS "nameEn",
      COALESCE(en.name, zh.name, category.canonical_name) AS "displayName",
      COUNT(service.id)::INTEGER AS "serviceCount"
    FROM service_categories category
    LEFT JOIN service_category_translations zh ON zh.shop_id=category.shop_id AND zh.category_id=category.id AND zh.locale='zh-CN'
    LEFT JOIN service_category_translations en ON en.shop_id=category.shop_id AND en.category_id=category.id AND en.locale='en'
    LEFT JOIN services service ON service.shop_id=category.shop_id AND service.category_id=category.id
    WHERE category.shop_id=$1 AND ($2::UUID IS NULL OR category.id=$2::UUID)
    GROUP BY category.id, zh.name, en.name
    ORDER BY category.sort_order, category.canonical_name`, [shopId, categoryId])) .rows;

  const upsertTranslation = (client, shopId, categoryId, locale, name) => client.query(`
    INSERT INTO service_category_translations (shop_id, category_id, locale, name)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (shop_id,category_id,locale) DO UPDATE SET name=EXCLUDED.name, updated_at=NOW()`,
  [shopId, categoryId, locale, name]);

  const sendError = (res, error, fallback) => {
    if (error instanceof OwnerServiceCategoryError) return res.status(error.status).json({ success:false, code:error.code, message:error.publicMessage });
    console.error('Owner service category error:', safeErrorCode(error));
    return res.status(500).json({ success:false, message:fallback });
  };

  const list = async (req, res) => { let client; try { client=await pool.connect(); const rows=await select(client,req.ownerAuth.shopId); return res.json({success:true,data:rows.map(row=>({...row,displayName:resolveCategoryName(row,req.query.locale)}))}); } catch(e){return sendError(res,e,'读取服务分类失败');} finally{client?.release();} };
  const create = async (req, res) => {
    const checked=validate(req.body,false); if(checked.error) return res.status(400).json({success:false,message:checked.error});
    try { const data=await runInTransaction(pool, async client=>{ const v=checked.values; const canonical=v.canonicalName||v.nameEn||v.nameZh;
      const result=await client.query(`INSERT INTO service_categories (shop_id,canonical_name,icon_key,sort_order,is_active) VALUES ($1,$2,$3,$4,$5) RETURNING id`,[req.ownerAuth.shopId,canonical,v.iconKey??null,v.sortOrder??0,v.isActive??true]);
      const id=result.rows[0]?.id; if(!id) throw new Error('category_insert_rowcount');
      if(v.nameZh) await upsertTranslation(client,req.ownerAuth.shopId,id,'zh-CN',v.nameZh);
      if(v.nameEn) await upsertTranslation(client,req.ownerAuth.shopId,id,'en',v.nameEn);
      return (await select(client,req.ownerAuth.shopId,id))[0]; }); return res.status(201).json({success:true,data});
    } catch(e){return sendError(res,e,'创建服务分类失败');}
  };
  const patch = async (req,res) => {
    if(!isUuid(req.params.categoryId)) return res.status(400).json({success:false,message:'分类ID不正确'});
    const checked=validate(req.body,true); if(checked.error) return res.status(400).json({success:false,message:checked.error});
    try { const data=await runInTransaction(pool,async client=>{ const locked=await client.query('SELECT id FROM service_categories WHERE id=$1 AND shop_id=$2 FOR UPDATE',[req.params.categoryId,req.ownerAuth.shopId]);
      if(locked.rows.length!==1) throw new OwnerServiceCategoryError('CATEGORY_NOT_FOUND',404,'未找到该分类');
      const v=checked.values, map={canonicalName:'canonical_name',iconKey:'icon_key',sortOrder:'sort_order',isActive:'is_active'};
      const entries=Object.entries(v).filter(([key])=>map[key]); if(entries.length){const params=entries.map(([,value])=>value); params.push(req.params.categoryId,req.ownerAuth.shopId); await client.query(`UPDATE service_categories SET ${entries.map(([key],i)=>`${map[key]}=$${i+1}`).join(',')},updated_at=NOW() WHERE id=$${params.length-1} AND shop_id=$${params.length}`,params);}
      if(v.nameZh) await upsertTranslation(client,req.ownerAuth.shopId,req.params.categoryId,'zh-CN',v.nameZh);
      if(v.nameEn) await upsertTranslation(client,req.ownerAuth.shopId,req.params.categoryId,'en',v.nameEn);
      return (await select(client,req.ownerAuth.shopId,req.params.categoryId))[0]; }); return res.json({success:true,data});
    } catch(e){return sendError(res,e,'更新服务分类失败');}
  };
  return { list, create, patch };
};

module.exports={createOwnerServiceCategoryManagement,OwnerServiceCategoryError,validateOwnerServiceCategoryFields:validate,resolveCategoryName};

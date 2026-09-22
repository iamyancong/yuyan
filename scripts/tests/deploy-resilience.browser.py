"""部署中心真实 Vue 页面故障注入；全部业务请求使用本地夹具，不连接或发布真实服务器。"""
import json
import os
import re
import time
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('YUYAN_TEST_URL', 'http://127.0.0.1:1420')
OUTPUT = os.environ.get('YUYAN_TEST_OUTPUT', '/tmp/yuyan-issue14-browser')
os.makedirs(OUTPUT, exist_ok=True)
ACCOUNT = {'accountId':'issue14-test','deviceId':'web','gitlabHost':'https://git.example.test','gitlabUserId':1,'gitlabUsername':'tester','gitlabDisplayName':'Tester','gitlabAvatarUrl':'','gitlabToken':'fixture-only','accessToken':'','refreshToken':'','teamId':'team-test','role':'operator','accessExpiresAt':'','refreshExpiresAt':''}
TARGET = {'id':1,'projectId':1,'projectName':'韧性验收项目','projectPath':'test/demo','repositoryUrl':'https://git.example.test/test/demo','defaultBranch':'dev','serverId':1,'serverName':'测试服务器','serverHost':'127.0.0.1','projectType':'frontend','envName':'测试','deployRoot':'/tmp/test','nginxConfPath':'/tmp/nginx.conf','nginxInstanceId':1,'visitUrl':'http://example.test','updatedAt':'2026-09-22T00:00:00Z','createdAt':'2026-09-22T00:00:00Z'}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='chrome')
    context = browser.new_context(viewport={'width':1440,'height':1000})
    context.add_init_script('sessionStorage.setItem("yuyan:web-account-session", '+json.dumps(json.dumps(ACCOUNT))+');')
    state = {'offline_until':0, 'task_offline_until':0, 'posts':0, 'reads':0, 'empty':False}
    errors = []

    def route(req):
        parsed = urlparse(req.request.url)
        path = parsed.path
        if path.startswith('/deploy-api/'):
            if path in ['/deploy-api/servers','/deploy-api/targets'] and time.monotonic() < state['offline_until']:
                req.fulfill(status=503, content_type='application/json', body=json.dumps({'error':'故障注入：中央暂时不可用'}))
                return
            data = []
            if path.endswith('/servers'):
                data = [{'id':1,'name':'测试服务器','host':'127.0.0.1','port':22,'username':'tester','nginxInstances':[]}]
            elif path.endswith('/targets/runtime-snapshots'):
                data = {'items':[], 'checkedAt':'2026-09-22T00:00:00Z'}
            elif path.endswith('/targets'):
                data = [] if state['empty'] else [TARGET]
            elif path.endswith('/records'):
                data = {'items':[], 'page':1, 'pageSize':20, 'total':0}
            elif path.endswith('/deploy-progress'):
                req.fulfill(status=404, content_type='application/json', body='{"error":"没有运行任务"}')
                return
            elif path.endswith('/deploy') and req.request.method == 'POST':
                state['posts'] += 1
                state['task_offline_until'] = time.monotonic() + 20
                events = [
                    {'type':'log','level':'info','stage':'connection','message':'已连接发布任务','timestamp':'2026-09-22T00:00:00Z','taskId':99,'targetId':1},
                    {'type':'stage','stage':'build','percent':45,'message':'正在构建','timestamp':'2026-09-22T00:00:01Z','taskId':99,'targetId':1},
                ]
                req.fulfill(status=200, content_type='application/x-ndjson', body='\n'.join(json.dumps(event) for event in events)+'\n')
                return
            elif path.endswith('/deploy-tasks/99'):
                state['reads'] += 1
                if time.monotonic() < state['task_offline_until']:
                    req.fulfill(status=503, content_type='application/json', body='{"error":"任务查询暂时不可用"}')
                    return
                state['offline_until'] = time.monotonic() + 20
                data = {'taskId':99,'targetId':1,'action':'deploy','operator':'Tester','startedAt':'2026-09-22T00:00:00Z','running':False,'result':{'id':9,'targetId':1,'status':'success','projectName':'韧性验收项目'},'error':None,'events':[]}
            req.fulfill(status=200, content_type='application/json', body=json.dumps({'success':True,'data':data}))
        elif '/api/v4/' in path:
            data = {'id':1,'username':'tester','name':'Tester'} if path.endswith('/user') else []
            req.fulfill(status=200, content_type='application/json', body=json.dumps(data))
        elif parsed.hostname not in ['127.0.0.1','localhost']:
            req.abort()
        else:
            req.continue_()

    context.route('**/*', route)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE+'/#/deploy')
    expect(page.get_by_text('韧性验收项目', exact=True).first).to_be_visible(timeout=60000)
    state['offline_until'] = time.monotonic() + 20
    page.get_by_role('button', name=re.compile(r'查\s*询')).click()
    expect(page.locator('.central-data-status.ant-alert-warning')).to_be_visible(timeout=10000)
    expect(page.get_by_text('韧性验收项目', exact=True).first).to_be_visible()
    publish = page.get_by_role('button', name=re.compile(r'^发\s*布$'))
    expect(publish).to_be_disabled()
    page.screenshot(path=OUTPUT+'/cached-warning.png')
    expect(page.locator('.central-data-status')).to_have_count(0, timeout=35000)
    expect(publish).to_be_enabled()
    print('PASS: 20 秒列表故障保留旧行、warning、禁用新发布，自动恢复', flush=True)

    publish.click()
    expect(page.get_by_role('button', name='开始发布')).to_be_visible(timeout=30000)
    page.get_by_role('button', name='开始发布').click()
    expect(page.get_by_text('连接暂时中断，正在核实任务状态', exact=False).first).to_be_visible(timeout=10000)
    expect(page.get_by_text('发布成功，站点已就绪！')).to_be_visible(timeout=35000)
    expect(page.locator('.central-data-status.ant-alert-warning')).to_be_visible(timeout=10000)
    expect(page.get_by_text('发布成功，站点已就绪！')).to_be_visible()
    assert state['posts'] == 1
    assert state['reads'] >= 2
    page.screenshot(path=OUTPUT+'/success-refresh-offline.png')
    print('PASS: 进度断线 20 秒后按任务 ID 对账成功，POST 仅一次，后续刷新失败不改写成功', flush=True)
    expect(page.locator('.central-data-status')).to_have_count(0, timeout=35000)
    expect(page.get_by_text('发布成功，站点已就绪！')).to_be_visible()

    state['empty'] = True
    state['offline_until'] = float('inf')
    first = context.new_page()
    first.on('pageerror', lambda error: errors.append(str(error)))
    first.goto(BASE+'/#/deploy')
    expect(first.locator('.central-data-status.ant-alert-error')).to_be_visible(timeout=30000)
    expect(first.get_by_role('button', name='立即重试')).to_be_visible()
    expect(first.get_by_text('自动重试已停止。', exact=False)).to_be_visible(timeout=35000)
    state['offline_until'] = 0
    first.get_by_role('button', name='立即重试').click()
    expect(first.get_by_text('暂无中央部署数据', exact=True)).to_be_visible(timeout=15000)
    expect(first.locator('.central-data-status.ant-alert-error')).to_have_count(0)
    print('PASS: 无缓存首屏 error + 手动重试，成功空列表正常显示', flush=True)
    assert not errors, errors
    with open(OUTPUT+'/result.json','w') as file:
        json.dump({'passed':True,'deployPosts':state['posts'],'reconciliationReads':state['reads'],'pageErrors':errors},file,ensure_ascii=False,indent=2)
    context.close()
    browser.close()

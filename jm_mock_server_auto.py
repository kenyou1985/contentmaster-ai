"""
即梦API Mock服务器 - 自动配置版本
自动从网站localStorage读取yunwu.ai API Key（如果可用）
或使用环境变量配置
"""
from flask import Flask, request, jsonify
from flask_cors import CORS
import time
import random
import requests
import os
import json

app = Flask(__name__)
CORS(app)  # 允许跨域请求

# ===================== 配置项 =====================
# 是否启用转发模式（转发到真实的即梦API）
FORWARD_TO_REAL_API = os.getenv('FORWARD_TO_REAL_API', 'false').lower() == 'true'
# 真实即梦API地址（如果启用转发模式）
REAL_API_BASE_URL = os.getenv('REAL_API_BASE_URL', 'http://localhost:5100')
# 是否使用yunwu.ai生成真实图片（默认启用）
USE_REAL_GENERATION = os.getenv('USE_REAL_GENERATION', 'true').lower() == 'true'
# yunwu.ai API Key（优先从环境变量读取，也可以从请求中获取）
YUNWU_API_KEY = os.getenv('YUNWU_API_KEY', '')
# ==================================================

# 存储从请求中获取的API Key（用于支持动态配置）
dynamic_api_keys = {}

def get_api_key_for_request(session_id=None):
    """获取API Key（优先级：环境变量 > 动态存储 > 空）"""
    if YUNWU_API_KEY:
        return YUNWU_API_KEY
    if session_id and session_id in dynamic_api_keys:
        return dynamic_api_keys[session_id]
    return None

def generate_mock_image_url(prompt, index, width, height):
    """生成模拟图片URL（占位图片）"""
    timestamp = int(time.time())
    return f"https://picsum.photos/{width}/{height}?random={timestamp}_{index}"

def generate_real_image_via_yunwu(prompt, width, height, api_key=None):
    """
    使用yunwu.ai API生成真实图片
    返回图片URL或base64数据
    """
    if not USE_REAL_GENERATION:
        return None
    
    api_key = api_key or get_api_key_for_request()
    if not api_key:
        return None
    
    try:
        # 使用yunwu.ai的图片生成API
        # 尝试使用sora-image模型（支持中文提示词）
        url = "https://yunwu.ai/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        # 计算比例
        aspect_ratio = width / height
        if abs(aspect_ratio - 1) < 0.1:
            ratio = "1:1"
        elif aspect_ratio < 1:
            ratio = "2:3"  # 竖屏
        else:
            ratio = "3:2"  # 横屏
        
        # sora-image需要添加比例标记
        final_prompt = f"{prompt}【{ratio}】"
        
        payload = {
            "model": "sora_image",
            "messages": [
                {
                    "role": "user",
                    "content": final_prompt
                }
            ],
            "temperature": 0.7
        }
        
        print(f"[真实生成] 调用yunwu.ai API生成图片...")
        response = requests.post(url, headers=headers, json=payload, timeout=60)
        
        if response.status_code == 200:
            result = response.json()
            # 解析响应，提取图片URL
            content = result.get('choices', [{}])[0].get('message', {}).get('content', '')
            
            # 尝试从Markdown格式中提取图片URL
            import re
            image_urls = re.findall(r'!\[.*?\]\((.*?)\)', content)
            if image_urls:
                print(f"[真实生成] 成功生成图片: {image_urls[0]}")
                return image_urls[0]
            
            # 尝试从JSON格式中提取
            try:
                if content.startswith('{'):
                    data = json.loads(content)
                    if 'url' in data:
                        return data['url']
                    if 'image_url' in data:
                        return data['image_url']
            except:
                pass
            
            # 如果都没有，尝试直接返回content（可能是URL）
            if content.startswith('http'):
                return content
        else:
            error_text = response.text[:200]
            print(f"[真实生成] yunwu.ai API返回错误: {response.status_code}, {error_text}")
                
    except Exception as e:
        print(f"[真实生成] 生成失败: {str(e)}")
        import traceback
        traceback.print_exc()
    
    return None

def forward_to_real_api(prompt, num_images, width, height, session_id):
    """
    转发请求到真实的即梦API
    如果真实API不可用，返回None
    """
    if not FORWARD_TO_REAL_API:
        return None
    
    try:
        url = f"{REAL_API_BASE_URL}/v1/images/generations"
        headers = {
            "Authorization": f"Bearer {session_id}",
            "Content-Type": "application/json"
        }
        data = {
            "prompt": prompt,
            "num_images": num_images,
            "width": width,
            "height": height
        }
        
        print(f"[转发模式] 转发请求到真实API: {url}")
        response = requests.post(url, headers=headers, json=data, timeout=60)
        
        if response.status_code == 200:
            result = response.json()
            print(f"[转发模式] 真实API返回成功")
            return result
        else:
            print(f"[转发模式] 真实API返回错误: {response.status_code}")
            return None
    except Exception as e:
        print(f"[转发模式] 转发失败: {str(e)}")
        return None

@app.route('/v1/images/generations', methods=['POST'])
def generate_images():
    """
    模拟即梦API的图片生成接口
    支持从请求中获取yunwu.ai API Key（通过X-Yunwu-API-Key头）
    """
    try:
        # 获取请求数据
        data = request.get_json()
        prompt = data.get('prompt', '')
        num_images = data.get('num_images', 1)
        width = data.get('width', 1080)
        height = data.get('height', 1920)
        
        # 获取Authorization头（即梦SESSION_ID）
        auth_header = request.headers.get('Authorization', '')
        session_id = auth_header.replace('Bearer ', '') if auth_header.startswith('Bearer ') else ''
        
        # 尝试从请求头获取yunwu.ai API Key（如果网站传递了）
        yunwu_api_key_from_request = request.headers.get('X-Yunwu-API-Key', '')
        if yunwu_api_key_from_request and session_id:
            dynamic_api_keys[session_id] = yunwu_api_key_from_request
            print(f"[配置] 从请求中获取yunwu.ai API Key: {yunwu_api_key_from_request[:10]}...")
        
        print(f"\n{'='*60}")
        print(f"[Mock API] 收到生成请求")
        print(f"  提示词: {prompt}")
        print(f"  数量: {num_images}")
        print(f"  尺寸: {width}x{height}")
        print(f"  Session ID: {session_id[:20]}...")
        print(f"  转发模式: {'启用' if FORWARD_TO_REAL_API else '禁用'}")
        print(f"  真实生成: {'启用' if USE_REAL_GENERATION else '禁用'}")
        print(f"{'='*60}")
        
        # 优先级1: 尝试转发到真实即梦API
        if FORWARD_TO_REAL_API:
            real_result = forward_to_real_api(prompt, num_images, width, height, session_id)
            if real_result and real_result.get('data'):
                print(f"[转发模式] 使用真实即梦API返回的图片")
                print(f"[转发模式] 返回 {len(real_result['data'])} 张图片")
                for i, item in enumerate(real_result['data'], 1):
                    print(f"  [{i}] {item.get('url', 'N/A')}")
                print(f"{'='*60}\n")
                return jsonify(real_result), 200
        
        # 优先级2: 使用yunwu.ai生成真实图片
        api_key = get_api_key_for_request(session_id)
        if USE_REAL_GENERATION and api_key:
            print(f"[真实生成] 使用yunwu.ai API生成真实图片...")
            image_urls = []
            success_count = 0
            
            for i in range(num_images):
                image_url = generate_real_image_via_yunwu(prompt, width, height, api_key)
                if image_url:
                    image_urls.append({"url": image_url})
                    success_count += 1
                    print(f"  [{i+1}] {image_url}")
                    # 延迟避免API限流
                    if i < num_images - 1:
                        time.sleep(2)
                else:
                    print(f"  [{i+1}] 生成失败，使用占位图片")
                    # 如果生成失败，使用占位图片
                    image_urls.append({"url": generate_mock_image_url(prompt, i, width, height)})
            
            if success_count > 0:
                print(f"[真实生成] 成功生成 {success_count}/{num_images} 张真实图片")
                print(f"{'='*60}\n")
                return jsonify({
                    "data": image_urls,
                    "status": "success",
                    "message": f"成功生成 {num_images} 张图片（{success_count} 张真实生成）",
                    "real_generation": True
                }), 200
        elif USE_REAL_GENERATION:
            print(f"[真实生成] 未配置yunwu.ai API Key，跳过真实生成")
        
        # 优先级3: Mock模式（占位图片）
        print(f"[Mock模式] 使用占位图片")
        print(f"[提示] 要生成真实图片，请:")
        print(f"  1. 设置环境变量: YUNWU_API_KEY=<您的API Key>")
        print(f"  2. 或者在网站中配置yunwu.ai API Key（网站会自动传递）")
        
        # 模拟生成延迟
        delay = random.uniform(1, 3)
        print(f"[Mock模式] 模拟生成中... (延迟 {delay:.1f} 秒)")
        time.sleep(delay)
        
        # 生成占位图片URL列表
        image_urls = []
        for i in range(num_images):
            url = generate_mock_image_url(prompt, i, width, height)
            image_urls.append({"url": url})
        
        print(f"[Mock模式] 生成完成，返回 {len(image_urls)} 张占位图片")
        for i, item in enumerate(image_urls, 1):
            print(f"  [{i}] {item['url']}")
        print(f"{'='*60}\n")
        
        return jsonify({
            "data": image_urls,
            "status": "success",
            "message": f"成功生成 {num_images} 张图片（Mock模式：占位图片）",
            "mock_mode": True,
            "note": "这是Mock模式返回的占位图片。要生成真实图片，请配置yunwu.ai API Key。"
        }), 200
        
    except Exception as e:
        print(f"[Mock API] 错误: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({
            "error": str(e),
            "status": "error"
        }), 500

@app.route('/health', methods=['GET'])
def health():
    """健康检查接口"""
    has_api_key = bool(YUNWU_API_KEY) or len(dynamic_api_keys) > 0
    return jsonify({
        "status": "ok",
        "service": "即梦API Mock服务器",
        "port": 5100,
        "forward_mode": FORWARD_TO_REAL_API,
        "real_generation": USE_REAL_GENERATION and has_api_key,
        "real_api_url": REAL_API_BASE_URL if FORWARD_TO_REAL_API else None,
        "has_yunwu_key": has_api_key
    }), 200

@app.route('/', methods=['GET'])
def index():
    """首页"""
    return jsonify({
        "service": "即梦API Mock服务器",
        "version": "2.0.0",
        "endpoints": {
            "POST /v1/images/generations": "生成图片",
            "GET /health": "健康检查"
        },
        "modes": {
            "mock": "返回占位图片（默认，如果未配置API Key）",
            "forward": "转发到真实即梦API（需设置环境变量）",
            "real_generation": "使用yunwu.ai生成真实图片（默认启用，需配置YUNWU_API_KEY）"
        },
        "usage": "使用jm.py脚本连接此服务器进行测试",
        "config": {
            "real_generation": "USE_REAL_GENERATION=true (默认启用)",
            "yunwu_api_key": "YUNWU_API_KEY=<您的API Key> 或通过网站自动传递",
            "forward_mode": "FORWARD_TO_REAL_API=true",
            "real_api_url": "REAL_API_BASE_URL=<真实API地址>"
        }
    }), 200

if __name__ == '__main__':
    print("\n" + "="*60)
    print("即梦API Mock服务器启动中...")
    print("="*60)
    print("服务地址: http://localhost:5100")
    print("API端点: POST http://localhost:5100/v1/images/generations")
    print("健康检查: GET http://localhost:5100/health")
    print("="*60)
    print(f"转发模式: {'启用' if FORWARD_TO_REAL_API else '禁用'}")
    print(f"真实生成: {'启用' if USE_REAL_GENERATION else '禁用'}")
    if USE_REAL_GENERATION:
        if YUNWU_API_KEY:
            print(f"yunwu.ai API Key: {YUNWU_API_KEY[:10]}... (已配置)")
            print("✓ 将使用yunwu.ai生成真实图片")
        else:
            print("yunwu.ai API Key: 未配置（将从网站请求中获取或使用占位图片）")
            print("提示: 设置环境变量 YUNWU_API_KEY 可启用真实生成")
    if FORWARD_TO_REAL_API:
        print(f"真实API地址: {REAL_API_BASE_URL}")
    print("="*60)
    print("\n提示: 在另一个终端运行 jm.py 脚本进行测试")
    print("按 Ctrl+C 停止服务器\n")
    print("="*60 + "\n")
    
    # 启动服务器
    app.run(host='0.0.0.0', port=5100, debug=True)

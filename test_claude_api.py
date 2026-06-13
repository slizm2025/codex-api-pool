#!/usr/bin/env python3
"""
Claude API 测试脚本
测试指定 API 端点的连接和响应
"""

import requests
import json
import time

# API 配置
BASE_URL = "https://x666.me"
API_KEY = "sk-p7ektFUET77hVoU1bU8bHVvHQzTpMVakIAbt0TrAPd7vkLwm"

def test_api_connection():
    """测试 API 基本连接"""
    print("=" * 60)
    print("Claude API 连接测试")
    print("=" * 60)
    print(f"Base URL: {BASE_URL}")
    print(f"API Key: {API_KEY[:20]}...")
    print()

    # 构造请求
    url = f"{BASE_URL}/v1/messages"
    headers = {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01"
    }

    payload = {
        "model": "claude-3-5-sonnet-20241022",
        "max_tokens": 1024,
        "messages": [
            {
                "role": "user",
                "content": "你好！请用一句话介绍你自己。"
            }
        ]
    }

    try:
        print("发送测试请求...")
        start_time = time.time()

        response = requests.post(url, headers=headers, json=payload, timeout=30)

        elapsed_time = time.time() - start_time

        print(f"响应状态码: {response.status_code}")
        print(f"响应时间: {elapsed_time:.2f} 秒")
        print()

        if response.status_code == 200:
            print("✓ 连接成功！")
            print()

            result = response.json()
            print("响应内容:")
            print("-" * 60)

            if "content" in result and len(result["content"]) > 0:
                assistant_message = result["content"][0]["text"]
                print(assistant_message)
            else:
                print(json.dumps(result, indent=2, ensure_ascii=False))

            print("-" * 60)
            print()
            print(f"Token 使用情况:")
            if "usage" in result:
                print(f"  输入 tokens: {result['usage'].get('input_tokens', 'N/A')}")
                print(f"  输出 tokens: {result['usage'].get('output_tokens', 'N/A')}")

            return True
        else:
            print("✗ 请求失败")
            print()
            print("错误详情:")
            print("-" * 60)
            try:
                error_data = response.json()
                print(json.dumps(error_data, indent=2, ensure_ascii=False))
            except:
                print(response.text)
            print("-" * 60)

            return False

    except requests.exceptions.Timeout:
        print("✗ 请求超时（30秒）")
        return False
    except requests.exceptions.ConnectionError:
        print("✗ 连接错误：无法连接到服务器")
        return False
    except Exception as e:
        print(f"✗ 发生错误: {type(e).__name__}: {str(e)}")
        return False

def test_streaming():
    """测试流式响应"""
    print()
    print("=" * 60)
    print("测试流式响应")
    print("=" * 60)

    url = f"{BASE_URL}/v1/messages"
    headers = {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01"
    }

    payload = {
        "model": "claude-3-5-sonnet-20241022",
        "max_tokens": 1024,
        "stream": True,
        "messages": [
            {
                "role": "user",
                "content": "请数到10，每个数字占一行。"
            }
        ]
    }

    try:
        print("发送流式请求...")
        response = requests.post(url, headers=headers, json=payload, stream=True, timeout=30)

        if response.status_code == 200:
            print("✓ 流式连接成功！")
            print()
            print("流式响应内容:")
            print("-" * 60)

            for line in response.iter_lines():
                if line:
                    line_str = line.decode('utf-8')
                    if line_str.startswith('data: '):
                        data_str = line_str[6:]
                        if data_str.strip() == '[DONE]':
                            break
                        try:
                            data = json.loads(data_str)
                            if data.get("type") == "content_block_delta":
                                if "delta" in data and "text" in data["delta"]:
                                    print(data["delta"]["text"], end="", flush=True)
                        except json.JSONDecodeError:
                            pass

            print()
            print("-" * 60)
            return True
        else:
            print(f"✗ 流式请求失败，状态码: {response.status_code}")
            return False

    except Exception as e:
        print(f"✗ 流式请求错误: {type(e).__name__}: {str(e)}")
        return False

if __name__ == "__main__":
    # 运行测试
    success = test_api_connection()

    if success:
        # 如果基本测试成功，运行流式测试
        test_streaming()

    print()
    print("=" * 60)
    print("测试完成")
    print("=" * 60)

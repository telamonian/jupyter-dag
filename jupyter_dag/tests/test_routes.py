"""The extension template's test of its example REST route."""

import json


async def test_hello(jp_fetch):
    # When
    response = await jp_fetch("jupyter-dag", "hello")

    # Then
    assert response.code == 200
    payload = json.loads(response.body)
    assert payload == {
            "data": (
                "Hello, world!"
                " This is the '/jupyter-dag/hello' endpoint."
                " Try visiting me in your browser!"
            ),
        }

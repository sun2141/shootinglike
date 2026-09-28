import cv2, numpy as np, sys
# usage: crops.py video out.jpg i0 i1 step x y w h scale
v,out,i0,i1,st,x,y,w,h,sc=sys.argv[1],sys.argv[2],*map(int,sys.argv[3:10]),float(sys.argv[10])
cap=cv2.VideoCapture(v); tiles=[]; i=0
while True:
    ok,f=cap.read()
    if not ok or i>i1: break
    if i>=i0 and (i-i0)%st==0:
        t=cap.get(cv2.CAP_PROP_POS_MSEC)/1000
        c=f[y:y+h,x:x+w].copy(); c=cv2.resize(c,None,fx=sc,fy=sc,interpolation=cv2.INTER_NEAREST if sc>1 else cv2.INTER_AREA)
        cv2.putText(c,f'{i} {t:.3f}',(3,18),cv2.FONT_HERSHEY_SIMPLEX,0.55,(0,255,255),2); tiles.append(c)
    i+=1
cols=4; H,W=tiles[0].shape[:2]
while len(tiles)%cols: tiles.append(np.zeros_like(tiles[0]))
rows=[np.hstack(tiles[r*cols:(r+1)*cols]) for r in range(len(tiles)//cols)]
g=np.vstack(rows)
# grid lines every 50 source px
cv2.imwrite(out,g,[cv2.IMWRITE_JPEG_QUALITY,88]); print(g.shape)

import sys, pickle, json, numpy as np
import solve, fit3
calp, clip = sys.argv[1], sys.argv[2]
J=pickle.load(open(calp,'rb'))
fit3.pose=lambda f,W,H:(J['R'],J['t'],J['C'],0.0)
CL={'08':((577.0,770.2),(348,428),0.0),'09':((552.9,776.2),(81,168),-1.02),'11':((581.4,769.3),(276,357),1.04)}
bc,fr,dy=CL[clip]
trk=json.load(open(f'/mnt/user-data/uploads/shooting-like/ref-rear/_work/t{clip}b.json'))
trk=[[r[0],r[1],r[2],(r[3]+dy if r[3] is not None else None)]+r[4:] for r in trk]
r=fit3.run(trk,np.array([bc[0],bc[1]+dy]),J['f'],7.44,2.5,fr)
ts,P=fit3.sim(r['P0'],r['v'],r['k'],r['spin'],2.5)
iz=np.where((P[1:,2]<0.11)&(P[:-1,2]>=0.11))[0]
land=f"lands t={r['t0']+ts[iz[0]+1]:.3f} at ({P[iz[0]+1,0]:.2f},{P[iz[0]+1,1]:.2f}) px={solve.proj(J['f'],J['R'],J['t'],P[iz[0]+1][None])[0].round(0)}" if len(iz) else ''
c=r['cross']
print(f"{clip} {calp} f={J['f']:.0f} v0={r['speed']:.1f} elev={r['elev']:.1f} rms={r['rms']:.2f} k={r['k']:.4f} t0={r['t0']:.3f} dist={-r['P0'][1]:.1f}m",
      (f"goalline t={c[0]:.3f} x={c[1][0]:.2f} z={c[1][2]:.2f}" if c else 'no cross'), land, flush=True)
uv=solve.proj(J['f'],J['R'],J['t'],P)
json.dump(dict(uv=uv[::5].tolist(),tt=(ts[::5]+r['t0']).tolist(),speed=r['speed'],elev=r['elev'],dist=float(-r['P0'][1])),open(f'tr_{clip}_{calp[:-4]}.json','w'))
